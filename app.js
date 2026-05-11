import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';
import { XRHandModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const THUMBNAIL_COLUMNS = 6;

let scene;
let camera;
let renderer;
let sphereMesh;
let galleryGroup;
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
let menuTimer = null;
let interactionLocked = false;
let xrSessionActive = false;

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
  createEnvironment();
  createStereoSphere();
  createGallery();
  createMenu();
  createLoadingIndicator();
  createStatusMessage();
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
  enterVRButton.style.position = 'absolute';
  enterVRButton.style.bottom = '30px';
  enterVRButton.style.left = '50%';
  enterVRButton.style.transform = 'translateX(-50%)';
  enterVRButton.style.fontSize = '18px';
  enterVRButton.style.padding = '14px 24px';
  enterVRButton.style.zIndex = '999';

  enterVRButton.addEventListener('click', enterVR);
  document.body.appendChild(enterVRButton);
}

async function enterVR() {
  if (!imageFiles.length || xrSessionActive) {
    return;
  }

  if (!navigator.xr) {
    updateStatus('WebXR is not available in this browser. Use a WebXR-capable headset browser over HTTPS.');
    return;
  }

  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  if (!supported) {
    updateStatus('Immersive VR is not supported on this device/browser.');
    return;
  }

  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
  });

  await renderer.xr.setSession(session);
  xrSessionActive = true;
  document.getElementById('ui').style.display = 'none';
  enterVRButton.style.display = 'none';
  statusMessage.style.display = 'none';

  populateGallery(imageFiles);
  showGallery();
}

function createStereoSphere() {
  const geometry = new THREE.SphereGeometry(50, 128, 128);
  geometry.scale(-1, 1, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      pano: { value: null },
      eyeIndex: { value: 0 },
      opacity: { value: 1 },
    },
    depthWrite: false,
    transparent: true,
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D pano;
      uniform int eyeIndex;
      uniform float opacity;
      varying vec2 vUv;

      void main() {
        vec2 uv = vUv;

        if (eyeIndex == 0) {
          uv.y = 0.5 + (uv.y * 0.5);
        } else {
          uv.y = uv.y * 0.5;
        }

        gl_FragColor = vec4(texture2D(pano, uv).rgb, opacity);
      }
    `,
  });

  sphereMesh = new THREE.Mesh(geometry, material);
  sphereMesh.visible = false;
  sphereMesh.frustumCulled = false;
  sphereMesh.renderOrder = -10;
  sphereMesh.onBeforeRender = (_renderer, _scene, activeCamera) => {
    const viewportX = activeCamera.viewport?.x ?? 0;
    sphereMesh.material.uniforms.eyeIndex.value = viewportX === 0 ? 0 : 1;
  };

  scene.add(sphereMesh);
}

function createGallery() {
  galleryGroup = new THREE.Group();
  galleryGroup.visible = false;
  scene.add(galleryGroup);
}

function populateGallery(files) {
  clearGallery();

  files.forEach(async (file, index) => {
    const texture = await createThumbnail(file);
    const card = createThumbnailCard(texture, file.name);

    const column = index % THUMBNAIL_COLUMNS;
    const row = Math.floor(index / THUMBNAIL_COLUMNS);
    const x = (column - (Math.min(files.length, THUMBNAIL_COLUMNS) - 1) / 2) * 0.78;
    const y = 1.6 - row * 0.62;
    const z = -2.6;

    card.position.set(x, y, z);
    card.userData.onClick = () => {
      currentImageIndex = index;
      loadStereoImage(file);
    };

    galleryGroup.add(card);
    galleryObjects.push(card);
    interactiveObjects.push(card);
  });
}

function clearGallery() {
  galleryObjects.forEach((object) => {
    removeInteractiveObject(object);
    galleryGroup.remove(object);
    disposeObject(object);
  });
  galleryObjects.length = 0;
}

function createThumbnailCard(texture, fileName) {
  const group = new THREE.Group();

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(0.68, 0.48),
    new THREE.MeshBasicMaterial({ color: 0x101722, transparent: true, opacity: 0.92 }),
  );
  frame.position.z = -0.01;
  group.add(frame);

  const thumbnail = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.34),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  thumbnail.position.y = 0.04;
  group.add(thumbnail);

  const labelTexture = createLabelTexture(shortenFileName(fileName), 512, 96, 28);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.12),
    new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true }),
  );
  label.position.y = -0.18;
  group.add(label);

  group.userData.defaultScale = new THREE.Vector3(1, 1, 1);
  return group;
}

function createMenu() {
  menuGroup = new THREE.Group();
  menuGroup.visible = false;

  const backButton = createMenuButton('THUMBNAILS', -0.86, 0.18, 0.7, 0.2);
  const prevButton = createMenuButton('PREV', -0.28, 0.18, 0.45, 0.2);
  const nextButton = createMenuButton('NEXT', 0.28, 0.18, 0.45, 0.2);
  const muteButton = createMenuButton('MUTE', 0.82, 0.18, 0.45, 0.2);
  const exitButton = createMenuButton('EXIT VR', 0, -0.16, 0.62, 0.2);

  backButton.userData.onClick = showGallery;
  prevButton.userData.onClick = prevImage;
  nextButton.userData.onClick = nextImage;
  muteButton.userData.onClick = toggleMute;
  exitButton.userData.onClick = exitVR;

  [backButton, prevButton, nextButton, muteButton, exitButton].forEach((button) => {
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
  ctx.font = 'bold 50px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

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
    new THREE.PlaneGeometry(1.2, 0.28),
    new THREE.MeshBasicMaterial({ map: createLabelTexture('Loading panorama...', 768, 160, 52), transparent: true }),
  );
  loadingText.position.set(0, 1.55, -2);
  loadingText.visible = false;
  scene.add(loadingText);
}

function createStatusMessage() {
  statusMessage = document.createElement('div');
  statusMessage.id = 'statusMessage';
  statusMessage.style.position = 'absolute';
  statusMessage.style.left = '50%';
  statusMessage.style.bottom = '92px';
  statusMessage.style.transform = 'translateX(-50%)';
  statusMessage.style.zIndex = '1000';
  statusMessage.style.maxWidth = '620px';
  statusMessage.style.padding = '12px 18px';
  statusMessage.style.borderRadius = '12px';
  statusMessage.style.color = 'white';
  statusMessage.style.background = 'rgba(0,0,0,0.72)';
  statusMessage.style.display = 'none';
  document.body.appendChild(statusMessage);
}

function updateStatus(message) {
  statusMessage.textContent = message;
  statusMessage.style.display = message ? 'block' : 'none';
}

function showMenu() {
  if (!xrSessionActive) {
    return;
  }

  positionGroupInFrontOfCamera(menuGroup, 1.7);
  menuGroup.visible = true;
  menuGroup.scale.setScalar(1);

  if (menuTimer) {
    clearTimeout(menuTimer);
  }

  menuTimer = setTimeout(hideMenu, 9000);
}

function hideMenu() {
  menuGroup.visible = false;
}

function toggleMute() {
  audioEnabled = !audioEnabled;
  if (currentAudio) {
    currentAudio.muted = !audioEnabled;
  }
  hideMenu();
}

function nextImage() {
  if (currentImageIndex < imageFiles.length - 1) {
    currentImageIndex += 1;
    loadStereoImage(imageFiles[currentImageIndex]);
  }
  hideMenu();
}

function prevImage() {
  if (currentImageIndex > 0) {
    currentImageIndex -= 1;
    loadStereoImage(imageFiles[currentImageIndex]);
  }
  hideMenu();
}

function showGallery() {
  sphereMesh.visible = false;
  galleryGroup.visible = true;
  positionGroupInFrontOfCamera(galleryGroup, 2.6);
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
  sphereMesh.visible = false;
  galleryGroup.visible = false;
  hideMenu();
  setPointerVisibility(true);
  document.getElementById('ui').style.display = 'flex';
  enterVRButton.style.display = 'block';
  enterVRButton.disabled = imageFiles.length === 0;
  enterVRButton.textContent = imageFiles.length ? 'Enter VR' : 'Choose images to enable VR';

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);

    controller.addEventListener('selectstart', () => {
      if (!clickFromRay(controller)) {
        showMenu();
      }
    });

    controller.addEventListener('squeezestart', showMenu);

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
      showMenu();
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

  const object = hits[0].object;
  object.scale.copy(object.userData.defaultScale ?? new THREE.Vector3(1, 1, 1)).multiplyScalar(1.12);
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
  const gamepad = controller.gamepad;
  const actuator = gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(0.25, 35);
}

function setupFolderInput() {
  document.getElementById('folderInput').addEventListener('change', (event) => {
    loadedFiles = Array.from(event.target.files);
    imageFiles = loadedFiles.filter((file) => file.type.startsWith('image/') || SUPPORTED_IMAGE_TYPES.includes(file.type));

    if (!imageFiles.length) {
      enterVRButton.disabled = true;
      enterVRButton.textContent = 'Choose images to enable VR';
      updateStatus('No supported images were found. Select a folder containing top/bottom stereo 360 images.');
      return;
    }

    enterVRButton.disabled = false;
    enterVRButton.textContent = `Enter VR (${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'})`;
    updateStatus('Ready. Put on your headset, press Enter VR, then point at a thumbnail and press trigger.');
  });
}

async function createThumbnail(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  URL.revokeObjectURL(url);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

async function loadStereoImage(imageFile) {
  loadingText.visible = true;
  galleryGroup.visible = false;
  hideMenu();

  const url = URL.createObjectURL(imageFile);
  const image = new Image();
  image.src = url;
  await image.decode();

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  fadeOutSphere(() => {
    const oldTexture = sphereMesh.material.uniforms.pano.value;
    sphereMesh.material.uniforms.pano.value = texture;
    oldTexture?.dispose?.();

    sphereMesh.visible = true;
    sphereMesh.material.uniforms.opacity.value = 0;
    playMatchingAudio(imageFile.name);
    setPointerVisibility(true);
    loadingText.visible = false;
    URL.revokeObjectURL(url);
    fadeInSphere();
  });
}

function fadeOutSphere(callback) {
  if (!sphereMesh.visible) {
    callback();
    return;
  }

  animateUniformOpacity(1, 0, callback);
}

function fadeInSphere() {
  animateUniformOpacity(0, 1);
}

function animateUniformOpacity(from, to, callback) {
  const duration = 180;
  const start = performance.now();

  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    sphereMesh.material.uniforms.opacity.value = THREE.MathUtils.lerp(from, to, progress);

    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      callback?.();
    }
  }

  requestAnimationFrame(step);
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
    controllers.forEach(handleController);
    hands.forEach(handleHand);
    renderer.render(scene, camera);
  });
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
