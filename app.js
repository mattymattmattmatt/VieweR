import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
// Pick up images even when the headset reports an empty MIME type (common for
// files copied onto a Quest). HEIC/HEIF/TIFF are matched too so we can show a
// helpful "convert me" message instead of silently dropping the file.
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif|tiff?)$/i;
const UNSUPPORTED_EXTENSIONS = /\.(heic|heif|tiff?|raw|dng|cr2|nef|arw)$/i;
// Wide, vertically-stacked, 3D thumbnails (25% larger than before).
const CARD_WIDTH = 1.875;
const CARD_HEIGHT = 0.625;
const CARD_GAP = 0.1;
// Show this many cards at once; the rest are reached via the up/down arrows.
const VISIBLE_CARDS = 4;
// Fraction of each eye-half kept for the thumbnail, centred — crops the blurry
// letterbox padding many top/bottom stereo photos add. Tweak if needed.
const THUMB_CROP = 0.5;
const MENU_BUTTON_HEIGHT = 0.22;

// Thumbstick rotation: snap the panorama in 30° increments.
const ROTATION_STEP = Math.PI / 6;
const STICK_TRIGGER = 0.6;
const STICK_RELEASE = 0.3;

let scene;
let camera;
let renderer;
let panoGroup;
let leftSphere;
let rightSphere;
let leftTexture = null;
let rightTexture = null;
let panoLayersReady = false;
let galleryGroup;
let galleryUpArrow;
let galleryDownArrow;
let galleryScroll = 0;
let menuGroup;
let loadingText;
let statusMessage;
let enterVRButton;

const controllers = [];
const hands = [];
const interactiveObjects = [];
const galleryObjects = [];

let loadedFiles = [];
let imageFiles = [];
let currentImageIndex = -1;
let currentAudio = null;
let audioEnabled = true;
let interactionLocked = false;
let sphereTargetRotationY = 0;
let xrSessionActive = false;
let xrSupported = false;
let xrSupportChecked = false;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const tempDirection = new THREE.Vector3();
const tempPosition = new THREE.Vector3();

init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03050a);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 1000);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('xr-canvas'),
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  createEnterVRButton();
  createStatusMessage();
  checkWebXRSupport();
  createEnvironment();
  createPanoSpheres();
  createGallery();
  createMenu();
  createLoadingIndicator();
  setupControllers();
  setupHands();
  setupFolderInput();

  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionend', handleSessionEnd);
}

function createEnvironment() {
  const geometry = new THREE.SphereGeometry(200, 32, 32);
  geometry.scale(-1, 1, 1);

  const material = new THREE.MeshBasicMaterial({ color: 0x05070f });
  scene.add(new THREE.Mesh(geometry, material));

  const light = new THREE.HemisphereLight(0xffffff, 0x334466, 1.1);
  scene.add(light);
}

function createEnterVRButton() {
  enterVRButton = document.createElement('button');
  enterVRButton.id = 'enterVRButton';
  enterVRButton.type = 'button';
  enterVRButton.textContent = 'Choose images to enable VR';
  enterVRButton.disabled = true;
  enterVRButton.style.fontSize = '18px';
  enterVRButton.style.padding = '14px 24px';
  enterVRButton.style.zIndex = '999';

  enterVRButton.addEventListener('click', enterVR);
  document.getElementById('ui').appendChild(enterVRButton);
}

async function checkWebXRSupport() {
  if (!navigator.xr) {
    xrSupportChecked = true;
    xrSupported = false;
    updateEnterVRButton();
    updateStatus('WebXR is not available here. On Quest 3, open this page in Meta Quest Browser over HTTPS.');
    return;
  }

  try {
    xrSupported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch (error) {
    console.warn('Unable to check immersive-vr support:', error);
    xrSupported = false;
  }

  xrSupportChecked = true;
  updateEnterVRButton();

  if (!xrSupported) {
    updateStatus('Immersive VR is not supported in this browser. On Quest 3, use Meta Quest Browser over HTTPS.');
  }
}

async function enterVR() {
  if (!imageFiles.length || xrSessionActive) {
    return;
  }

  if (!navigator.xr) {
    updateStatus('WebXR is not available here. On Quest 3, open this page in Meta Quest Browser over HTTPS.');
    return;
  }

  if (xrSupportChecked && !xrSupported) {
    updateStatus('Immersive VR is not supported in this browser. On Quest 3, use Meta Quest Browser over HTTPS.');
    return;
  }

  let session;
  try {
    // Keep requestSession as the first awaited WebXR call in the click handler so
    // Quest Browser still treats it as a user-initiated action.
    session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
  } catch (error) {
    console.error('Unable to start immersive-vr session:', error);
    updateStatus(`Could not enter VR: ${error.message || 'the browser rejected the WebXR session request.'}`);
    return;
  }

  await renderer.xr.setSession(session);
  xrSessionActive = true;
  document.getElementById('ui').style.display = 'none';
  enterVRButton.style.display = 'none';
  statusMessage.style.display = 'none';

  // Show the whole accumulated collection as thumbnails, and open the most
  // recently added image straight away.
  populateGallery(imageFiles);
  currentImageIndex = imageFiles.length - 1;
  loadStereoImage(imageFiles[currentImageIndex]);
}

// Top/bottom (over-under) stereo is rendered the standard three.js way: two
// inverted spheres, each on its own layer, with the left eye showing the top
// half of the image and the right eye the bottom half. The WebXR sub-cameras
// are told which layer to see in the animation loop. This replaces the old
// custom shader, which relied on a per-eye viewport hack that doesn't fire
// reliably under WebXR.
function createPanoSpheres() {
  panoGroup = new THREE.Group();
  panoGroup.visible = false;

  const geometry = new THREE.SphereGeometry(50, 64, 48);
  geometry.scale(-1, 1, 1);

  leftSphere = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  leftSphere.frustumCulled = false;
  leftSphere.layers.set(1); // left eye only

  rightSphere = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  rightSphere.frustumCulled = false;
  rightSphere.layers.set(2); // right eye only

  panoGroup.add(leftSphere, rightSphere);
  scene.add(panoGroup);
}

function applyPanoTextures(baseTexture) {
  disposePanoTextures();

  // Top half of the file -> left eye. (If depth looks inverted on the headset,
  // swap the two offset.y values below.)
  leftTexture = baseTexture;
  configureEyeTexture(leftTexture, 0.5);

  rightTexture = baseTexture.clone();
  rightTexture.needsUpdate = true;
  configureEyeTexture(rightTexture, 0.0);

  leftSphere.material.map = leftTexture;
  leftSphere.material.color.set(0xffffff);
  leftSphere.material.needsUpdate = true;

  rightSphere.material.map = rightTexture;
  rightSphere.material.color.set(0xffffff);
  rightSphere.material.needsUpdate = true;
}

function configureEyeTexture(texture, offsetY) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; // seamless 360° horizontally
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.repeat.set(1, 0.5);
  texture.offset.set(0, offsetY);
  texture.needsUpdate = true;
}

function disposePanoTextures() {
  leftSphere.material.map = null;
  rightSphere.material.map = null;
  // leftTexture aliases the base texture; rightTexture is its clone.
  leftTexture?.dispose?.();
  rightTexture?.dispose?.();
  leftTexture = null;
  rightTexture = null;
}

function createGallery() {
  galleryGroup = new THREE.Group();
  galleryGroup.visible = false;

  // Persistent scroll arrows (kept out of galleryObjects so clearGallery leaves
  // them alone). Positioned/shown by layoutGallery.
  galleryUpArrow = createMenuButton('▲', 0, 0, 0.5, 0.18);
  galleryUpArrow.userData.onClick = () => scrollGallery(-1);

  galleryDownArrow = createMenuButton('▼', 0, 0, 0.5, 0.18);
  galleryDownArrow.userData.onClick = () => scrollGallery(1);

  galleryGroup.add(galleryUpArrow, galleryDownArrow);
  interactiveObjects.push(galleryUpArrow, galleryDownArrow);

  scene.add(galleryGroup);
}

function populateGallery(files) {
  clearGallery();
  galleryScroll = 0;

  // Newest first (top of the list). Cards are created synchronously with a
  // placeholder so their order is stable, then the real stereo textures are
  // swapped in as they decode.
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const file = files[i];
    const index = i;
    const card = createThumbnailCard(createPlaceholderEyes(), file.name);

    card.userData.onClick = () => {
      currentImageIndex = index;
      loadStereoImage(file);
    };

    galleryGroup.add(card);
    galleryObjects.push(card);
    interactiveObjects.push(card);

    createThumbnailEyes(file)
      .then((eyes) => swapCardEyes(card, eyes))
      .catch(() => {});
  }

  layoutGallery();
}

// Position the visible window of cards and toggle the scroll arrows.
function layoutGallery() {
  const total = galleryObjects.length;
  const maxScroll = Math.max(0, total - VISIBLE_CARDS);
  galleryScroll = Math.min(Math.max(galleryScroll, 0), maxScroll);

  const step = CARD_HEIGHT + CARD_GAP;
  const centerSlot = (VISIBLE_CARDS - 1) / 2;

  galleryObjects.forEach((card, index) => {
    const slot = index - galleryScroll;
    const visible = slot >= 0 && slot < VISIBLE_CARDS;
    card.visible = visible;
    if (visible) {
      card.position.set(0, (centerSlot - slot) * step, 0);
    }
  });

  galleryUpArrow.position.set(0, (centerSlot + 0.9) * step, 0);
  galleryDownArrow.position.set(0, -(centerSlot + 0.9) * step, 0);
  galleryUpArrow.visible = galleryScroll > 0;
  galleryDownArrow.visible = galleryScroll < maxScroll;
}

function scrollGallery(direction) {
  galleryScroll += direction;
  layoutGallery();
}

function swapCardEyes(card, eyes) {
  const { leftPlane, rightPlane } = card.userData;
  leftPlane.material.map?.dispose?.();
  rightPlane.material.map?.dispose?.();
  leftPlane.material.map = eyes.left;
  rightPlane.material.map = eyes.right;
  leftPlane.material.needsUpdate = true;
  rightPlane.material.needsUpdate = true;
}

function clearGallery() {
  galleryObjects.forEach((object) => {
    removeInteractiveObject(object);
    galleryGroup.remove(object);
    disposeObject(object);
  });
  galleryObjects.length = 0;
}

function createThumbnailCard(eyes, fileName) {
  const group = new THREE.Group();

  // Frame sits behind on layer 0 (both eyes) and is the raycast click target —
  // the eye planes are on layers 1/2 which the raycaster ignores.
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_WIDTH + 0.05, CARD_HEIGHT + 0.05),
    new THREE.MeshBasicMaterial({ color: 0x0c131c, transparent: true, opacity: 0.96 }),
  );
  frame.position.z = -0.012;
  group.add(frame);

  const planeGeometry = new THREE.PlaneGeometry(CARD_WIDTH, CARD_HEIGHT);

  const leftPlane = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ map: eyes.left }));
  leftPlane.layers.set(1);
  group.add(leftPlane);

  const rightPlane = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ map: eyes.right }));
  rightPlane.layers.set(2);
  group.add(rightPlane);

  group.userData.leftPlane = leftPlane;
  group.userData.rightPlane = rightPlane;

  const labelTexture = createLabelTexture(shortenFileName(fileName), 768, 96, 30);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_WIDTH * 0.7, 0.1),
    new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true }),
  );
  label.position.set(0, -CARD_HEIGHT / 2 + 0.02, 0.002);
  group.add(label);

  group.userData.defaultScale = new THREE.Vector3(1, 1, 1);
  return group;
}

function createMenu() {
  menuGroup = new THREE.Group();
  menuGroup.visible = false;

  // Two actions only. The B/Y button closes the menu, so a Cancel button is
  // redundant; audio mute was dropped as unused.
  const thumbnailsButton = createMenuButton('THUMBNAILS', -0.46, 0, 0.84, MENU_BUTTON_HEIGHT);
  const loadAnotherButton = createMenuButton('LOAD ANOTHER', 0.46, 0, 0.84, MENU_BUTTON_HEIGHT);

  thumbnailsButton.userData.onClick = showGallery;
  loadAnotherButton.userData.onClick = exitVR;

  [thumbnailsButton, loadAnotherButton].forEach((button) => {
    menuGroup.add(button);
    interactiveObjects.push(button);
  });

  scene.add(menuGroup);
}

function createMenuButton(text, x, y, width, height) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: createButtonTexture(text), transparent: true }),
  );

  mesh.position.set(x, y, 0);
  mesh.userData.defaultScale = new THREE.Vector3(1, 1, 1);
  return mesh;
}

function createButtonTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#1f8dff');
  gradient.addColorStop(1, '#0b2f55');
  ctx.fillStyle = gradient;
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.fillStyle = 'white';
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 48);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createLabelTexture(text, width, height, fontSize) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'white';
  ctx.font = `600 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2, width - 24);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createLoadingIndicator() {
  loadingText = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.56),
    new THREE.MeshBasicMaterial({ map: createMessageTexture('Loading panorama…'), transparent: true }),
  );
  loadingText.position.set(0, 1.5, -2);
  loadingText.renderOrder = 20;
  loadingText.visible = false;
  scene.add(loadingText);
}

// Swap the message plane's texture and show it. Used for loading + errors so
// the user always gets readable feedback inside the headset.
function showSphereMessage(text) {
  const previous = loadingText.material.map;
  loadingText.material.map = createMessageTexture(text);
  loadingText.material.needsUpdate = true;
  previous?.dispose?.();
  loadingText.visible = true;
}

function createMessageTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 36);
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.font = '600 46px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapText(ctx, text, canvas.width - 100);
  const lineHeight = 58;
  const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, startY + index * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  text.split('\n').forEach((paragraph) => {
    let current = '';
    paragraph.split(' ').forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    lines.push(current);
  });
  return lines;
}

function createStatusMessage() {
  statusMessage = document.createElement('div');
  statusMessage.id = 'statusMessage';
  statusMessage.style.maxWidth = '620px';
  statusMessage.style.padding = '12px 18px';
  statusMessage.style.borderRadius = '12px';
  statusMessage.style.color = 'white';
  statusMessage.style.background = 'rgba(0,0,0,0.72)';
  statusMessage.style.display = 'none';
  statusMessage.style.textAlign = 'center';
  statusMessage.style.lineHeight = '1.35';
  statusMessage.style.pointerEvents = 'none';
  document.getElementById('ui').appendChild(statusMessage);
}

function updateStatus(message) {
  if (!statusMessage) {
    return;
  }

  statusMessage.textContent = message;
  statusMessage.style.display = message ? 'block' : 'none';
}

function updateEnterVRButton() {
  if (!enterVRButton) {
    return;
  }

  if (!imageFiles.length) {
    enterVRButton.disabled = true;
    enterVRButton.textContent = 'Choose images to enable VR';
    return;
  }

  if (!xrSupportChecked) {
    enterVRButton.disabled = true;
    enterVRButton.textContent = 'Checking VR support...';
    return;
  }

  if (!xrSupported) {
    enterVRButton.disabled = true;
    enterVRButton.textContent = 'VR not available in this browser';
    return;
  }

  enterVRButton.disabled = false;
  enterVRButton.textContent = `Enter VR (${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'})`;
}

function toggleMenu() {
  if (!xrSessionActive) {
    return;
  }

  if (menuGroup.visible) {
    hideMenu();
  } else {
    showMenu();
  }
}

function showMenu() {
  if (!xrSessionActive) {
    return;
  }

  positionGroupInFrontOfCamera(menuGroup, 1.7);
  menuGroup.visible = true;
  menuGroup.scale.setScalar(1);
  // Bring the pointer back so the menu buttons can be aimed at.
  setPointerVisibility(true);
}

function hideMenu() {
  menuGroup.visible = false;
  // Hide the pointer again only when we drop back to the clean panorama view.
  if (!galleryGroup.visible && panoGroup.visible) {
    setPointerVisibility(false);
  }
}

function showGallery() {
  panoGroup.visible = false;
  galleryGroup.visible = true;
  positionGroupInFrontOfCamera(galleryGroup, 3.0);
  setPointerVisibility(true);
  hideMenu();

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

function exitVR() {
  const session = renderer.xr.getSession();
  if (session) {
    session.end();
  }
}

function handleSessionEnd() {
  xrSessionActive = false;
  panoLayersReady = false;
  panoGroup.visible = false;
  galleryGroup.visible = false;
  hideMenu();
  setPointerVisibility(true);
  document.getElementById('ui').style.display = 'flex';
  enterVRButton.style.display = 'block';
  updateEnterVRButton();

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.userData.stickActive = false;
    controller.userData.menuPressed = false;

    // The targetRaySpace returned by getController does not expose the gamepad
    // directly, so grab the live XRInputSource gamepad from the connect event.
    controller.addEventListener('connected', (event) => {
      controller.userData.gamepad = event.data.gamepad;
    });
    controller.addEventListener('disconnected', () => {
      controller.userData.gamepad = null;
    });

    // Trigger is only for pointing/clicking; the menu is opened with B/Y.
    controller.addEventListener('selectstart', () => {
      clickFromRay(controller);
    });

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0x66ccff }),
    );
    line.name = 'pointer';
    line.scale.z = 5;
    controller.add(line);

    scene.add(controller);
    controllers.push(controller);
  }
}

function setPointerVisibility(visible) {
  controllers.forEach((controller) => {
    const pointer = controller.getObjectByName('pointer');
    if (pointer) {
      pointer.visible = visible;
    }
  });
}

function setupHands() {
  const factory = new XRHandModelFactory();

  for (let i = 0; i < 2; i += 1) {
    const hand = renderer.xr.getHand(i);
    hand.add(factory.createHandModel(hand, 'mesh'));
    hand.userData.isPinching = false;
    scene.add(hand);
    hands.push(hand);
  }
}

function detectPinch(hand) {
  const indexTip = hand.joints['index-finger-tip'];
  const thumbTip = hand.joints['thumb-tip'];

  if (!indexTip || !thumbTip) {
    return false;
  }

  return indexTip.position.distanceTo(thumbTip.position) < 0.025;
}

function handleHand(hand) {
  const indexTip = hand.joints['index-finger-tip'];
  if (!indexTip) {
    return;
  }

  raycaster.ray.origin.copy(indexTip.position);
  raycaster.ray.direction.set(0, 0, -1).applyQuaternion(indexTip.quaternion);

  const hit = updateHoverState();
  const pinch = detectPinch(hand);

  if (pinch && !hand.userData.isPinching) {
    if (hit) {
      runInteraction(hit.object);
    } else {
      // Hand tracking has no B/Y button, so a pinch on empty space opens the menu.
      toggleMenu();
    }
  }

  hand.userData.isPinching = pinch;
}

function handleController(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  updateHoverState();
}

function pollControllerInput(controller) {
  const gamepad = controller.userData.gamepad;
  if (!gamepad) {
    return;
  }

  // B / Y face button (xr-standard index 5) toggles the in-VR menu.
  const menuPressed = gamepad.buttons[5]?.pressed ?? false;
  if (menuPressed && !controller.userData.menuPressed) {
    toggleMenu();
    pulseController(controller);
  }
  controller.userData.menuPressed = menuPressed;

  // Thumbstick left/right snaps the panorama in 30° increments while viewing.
  const axes = gamepad.axes;
  const stickX = axes.length >= 4 ? axes[2] : axes[0] ?? 0;

  if (!panoGroup.visible) {
    controller.userData.stickActive = false;
    return;
  }

  if (!controller.userData.stickActive) {
    if (stickX > STICK_TRIGGER) {
      rotateSphere(1, controller);
      controller.userData.stickActive = true;
    } else if (stickX < -STICK_TRIGGER) {
      rotateSphere(-1, controller);
      controller.userData.stickActive = true;
    }
  } else if (Math.abs(stickX) < STICK_RELEASE) {
    controller.userData.stickActive = false;
  }
}

function rotateSphere(direction, controller) {
  sphereTargetRotationY += direction * ROTATION_STEP;
  pulseController(controller);
}

function clickFromRay(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  const hits = getVisibleHits();
  if (!hits.length) {
    return false;
  }

  runInteraction(hits[0].object);
  pulseController(controller);
  return true;
}

function updateHoverState() {
  resetInteractiveScales();
  const hits = getVisibleHits();
  if (!hits.length) {
    return null;
  }

  const target = findInteractiveTarget(hits[0].object) ?? hits[0].object;
  target.scale.copy(target.userData.defaultScale ?? new THREE.Vector3(1, 1, 1)).multiplyScalar(1.12);
  return hits[0];
}

function getVisibleHits() {
  return raycaster.intersectObjects(interactiveObjects, true).filter((hit) => isActuallyVisible(hit.object));
}

function runInteraction(object) {
  const target = findInteractiveTarget(object);
  if (!target || interactionLocked) {
    return;
  }

  interactionLocked = true;
  target.userData.onClick?.();
  setTimeout(() => {
    interactionLocked = false;
  }, 250);
}

function findInteractiveTarget(object) {
  let cursor = object;
  while (cursor) {
    if (typeof cursor.userData.onClick === 'function') {
      return cursor;
    }
    cursor = cursor.parent;
  }
  return null;
}

function isActuallyVisible(object) {
  let cursor = object;
  while (cursor) {
    if (!cursor.visible) {
      return false;
    }
    cursor = cursor.parent;
  }
  return true;
}

function resetInteractiveScales() {
  interactiveObjects.forEach((object) => {
    const defaultScale = object.userData.defaultScale;
    if (defaultScale) {
      object.scale.copy(defaultScale);
    }
  });
}

function pulseController(controller) {
  const actuator = controller?.userData?.gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(0.25, 35);
}

function setupFolderInput() {
  document.getElementById('folderInput').addEventListener('change', (event) => {
    // Quest's file picker only allows one file at a time, so accumulate picks
    // across visits instead of replacing. Each new image becomes another
    // thumbnail you can return to via the in-VR THUMBNAILS button.
    const existingKeys = new Set(loadedFiles.map(fileKey));
    Array.from(event.target.files).forEach((file) => {
      if (!existingKeys.has(fileKey(file))) {
        loadedFiles.push(file);
        existingKeys.add(fileKey(file));
      }
    });

    imageFiles = loadedFiles.filter(
      (file) =>
        file.type.startsWith('image/') ||
        SUPPORTED_IMAGE_TYPES.includes(file.type) ||
        IMAGE_EXTENSIONS.test(file.name),
    );

    // Let the change event fire again if the same file is re-picked next time.
    event.target.value = '';

    updateEnterVRButton();

    if (!imageFiles.length) {
      updateStatus('No supported images were found. Select a top/bottom stereo 360 image (JPG or PNG).');
      return;
    }

    if (xrSupportChecked && !xrSupported) {
      updateStatus('Image added, but immersive VR is not available in this browser. On Quest 3, use Meta Quest Browser over HTTPS.');
      return;
    }

    updateStatus(`Ready — ${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} loaded. Press Enter VR to open the latest; use THUMBNAILS in VR to switch.`);
  });
}

// Stable identity for a picked File so the same image isn't added twice.
function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// Build a stereo pair of thumbnail textures (top half -> left eye, bottom half
// -> right eye) so each card previews in 3D, matching the main viewer.
async function createThumbnailEyes(file) {
  const url = URL.createObjectURL(file);
  let source;
  let width;
  let height;

  try {
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    } catch (primaryError) {
      if (typeof createImageBitmap !== 'function') {
        throw primaryError;
      }
      source = await createImageBitmap(file);
      width = source.width;
      height = source.height;
    }

    const eyes = {
      left: halfTexture(source, width, height, 'top'),
      right: halfTexture(source, width, height, 'bottom'),
    };
    source.close?.();
    return eyes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function halfTexture(source, width, height, which) {
  // Canvas matches the card's 3:1 aspect so the cropped strip fills it.
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');

  // Keep the centre band of each eye-half, dropping the blurry top/bottom pad.
  const halfHeight = Math.floor(height / 2);
  const keptHeight = Math.floor(halfHeight * THUMB_CROP);
  const inset = Math.floor((halfHeight - keptHeight) / 2);
  const sourceY = (which === 'top' ? 0 : halfHeight) + inset;
  ctx.drawImage(source, 0, sourceY, width, keptHeight, 0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

// Fallback eye pair for images the browser can't decode (e.g. HEIC).
function createPlaceholderEyes() {
  return { left: createPlaceholderTexture(), right: createPlaceholderTexture() };
}

function createPlaceholderTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b2733';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '600 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No preview', canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

async function loadStereoImage(imageFile) {
  galleryGroup.visible = false;
  hideMenu();
  showSphereMessage('Loading panorama…');

  // Start every panorama facing forward.
  sphereTargetRotationY = 0;
  panoGroup.rotation.y = 0;

  try {
    const texture = await buildPanoTexture(imageFile);

    applyPanoTextures(texture);
    panoGroup.visible = true;
    loadingText.visible = false;
    playMatchingAudio(imageFile.name);
    // Clean, control-free view while looking at the panorama.
    setPointerVisibility(false);
  } catch (error) {
    console.error('Unable to load panorama:', error);
    const hint = UNSUPPORTED_EXTENSIONS.test(imageFile.name) || /heic|heif/.test(imageFile.type)
      ? `Can't open ${imageFile.name}. The Quest browser can't decode HEIC/HEIF/RAW photos — re-save it as JPG or PNG.`
      : `Couldn't load ${imageFile.name}. Try a JPG, PNG, or WebP panorama (and check it isn't larger than the headset can handle).`;

    showSphereMessage(hint);
    updateStatus(hint);
    setPointerVisibility(true);

    // Leave the thumbnail grid up (when there is more than one image) so the
    // user can pick another without leaving VR; the menu's B/Y button still works.
    if (xrSessionActive && imageFiles.length > 1) {
      galleryGroup.visible = true;
      positionGroupInFrontOfCamera(galleryGroup, 2.6);
    }
  }
}

// Decode a file into a panorama texture. Tries an <img> first (matches the
// original orientation handling), then falls back to createImageBitmap, which
// can decode some files <img> rejects and lets us downscale very large
// panoramas without exhausting the headset's memory. Oversized images are
// capped to the GPU's max texture size.
async function buildPanoTexture(imageFile) {
  // Cap at 4096 on the longest side: the texture is uploaded once per eye, so
  // two copies of a huge panorama would otherwise blow the headset's memory.
  const maxSize = Math.min(renderer?.capabilities?.maxTextureSize || 4096, 4096);
  const url = URL.createObjectURL(imageFile);

  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return imageToTexture(image, image.naturalWidth, image.naturalHeight, maxSize);
  } catch (primaryError) {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(imageFile).catch(() => null);
      if (bitmap) {
        const texture = imageToTexture(bitmap, bitmap.width, bitmap.height, maxSize);
        bitmap.close?.();
        return texture;
      }
    }
    throw primaryError;
  } finally {
    // Safe to revoke now: a decoded <img> and any drawn canvas no longer need the URL.
    URL.revokeObjectURL(url);
  }
}

function imageToTexture(source, width, height, maxSize) {
  let texture;
  const scale = Math.min(1, maxSize / Math.max(width, height || 1));

  if (scale < 1) {
    // Downscale oversized panoramas through a canvas so the GPU upload succeeds.
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    texture = new THREE.CanvasTexture(canvas);
  } else {
    texture = new THREE.Texture(source);
    texture.needsUpdate = true;
  }

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function playMatchingAudio(imageName) {
  const base = imageName.substring(0, imageName.lastIndexOf('.'));
  const audioFile = loadedFiles.find((file) => file.name.startsWith(base) && (file.type.startsWith('audio/') || file.type.startsWith('video/')));

  if (!audioFile) {
    return;
  }

  if (currentAudio) {
    currentAudio.pause();
  }

  currentAudio = document.createElement('audio');
  currentAudio.src = URL.createObjectURL(audioFile);
  currentAudio.loop = true;
  currentAudio.muted = !audioEnabled;
  currentAudio.play().catch(() => {
    updateStatus('Audio could not autoplay. It will remain muted until the browser allows playback.');
  });
}

function positionGroupInFrontOfCamera(group, distance) {
  camera.getWorldDirection(tempDirection);
  camera.getWorldPosition(tempPosition);

  group.position.copy(tempPosition).add(tempDirection.multiplyScalar(distance));
  group.position.y = Math.max(group.position.y, 1.15);
  group.lookAt(tempPosition.x, group.position.y, tempPosition.z);
}

function shortenFileName(fileName) {
  if (fileName.length <= 24) {
    return fileName;
  }

  const extensionIndex = fileName.lastIndexOf('.');
  const extension = extensionIndex > -1 ? fileName.slice(extensionIndex) : '';
  return `${fileName.slice(0, 17)}…${extension}`;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function removeInteractiveObject(object) {
  const index = interactiveObjects.indexOf(object);
  if (index >= 0) {
    interactiveObjects.splice(index, 1);
  }
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose?.());
    } else {
      child.material?.map?.dispose?.();
      child.material?.dispose?.();
    }
  });
}

function animate() {
  renderer.setAnimationLoop(() => {
    controllers.forEach((controller) => {
      handleController(controller);
      pollControllerInput(controller);
    });
    hands.forEach(handleHand);

    // Once the WebXR session provides its two eye cameras, let each one see its
    // matching panorama sphere (left eye -> layer 1, right eye -> layer 2).
    if (xrSessionActive && !panoLayersReady) {
      const xrCamera = renderer.xr.getCamera();
      if (xrCamera.cameras && xrCamera.cameras.length >= 2) {
        xrCamera.cameras[0].layers.enable(1);
        xrCamera.cameras[1].layers.enable(2);
        panoLayersReady = true;
      }
    }

    // Ease toward the snapped target rotation for a smooth 30° step.
    if (panoGroup) {
      panoGroup.rotation.y += (sphereTargetRotationY - panoGroup.rotation.y) * 0.2;
    }

    renderer.render(scene, camera);
  });
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
