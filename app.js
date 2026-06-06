import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
// Pick up images even when the headset reports an empty MIME type (common for
// files copied onto a Quest). HEIC/HEIF/TIFF are matched too so we can show a
// helpful "convert me" message instead of silently dropping the file.
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif|tiff?)$/i;
const UNSUPPORTED_EXTENSIONS = /\.(heic|heif|tiff?|raw|dng|cr2|nef|arw)$/i;
// Wide, vertically-stacked, 3D thumbnails.
const CARD_WIDTH = 2.967;
const CARD_HEIGHT = 0.6875;
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

// How much of each eye's vertical field to drop at the top and bottom. Many
// top/bottom stereo photos pad the poles with blur (often asymmetrically), so we
// render only the kept band on a matching partial sphere. cropTop/cropBottom are
// independent fractions removed from each end (0,0 = full sphere).
const DEFAULT_PANO_CROP = 0.62; // default kept fraction (symmetric)
let cropTop = (1 - DEFAULT_PANO_CROP) / 2;
let cropBottom = (1 - DEFAULT_PANO_CROP) / 2;
let cropAuto = true;
let manualCrop = DEFAULT_PANO_CROP;

// Render sharpness / performance tuning (Quest).
// - Super resolution > 1 supersamples the XR framebuffer for crisper detail
//   (applies on entering VR). Adjustable in Settings.
// - Fixed foveation (0..1) drops periphery detail to claw back GPU headroom.
let superSample = 1.4;
const FOVEATION = 0.5;
let maxAnisotropy = 1;

let scene;
let camera;
let renderer;
let environmentMesh;
let passthroughEnabled = false;
let arSupported = false;
let panoBrightness = 1;
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
let galleryDirty = true;
let thumbBuildToken = 0;
let menuGroup;
let settingsMenuGroup;
let vrCropButton;
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
let imageLoading = false;
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
    alpha: true, // allow a transparent clear for AR passthrough
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  // Sharper image + smoother framerate on Quest: supersample the XR
  // framebuffer, enable fixed foveation, and use the GPU's max anisotropy.
  maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  renderer.xr.setFramebufferScaleFactor(superSample);
  renderer.xr.setFoveation(FOVEATION);

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
  setupInputs();
  setupDropZone();
  setupPassthroughToggle();
  setupSettings();
  restoreLibrary();

  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionend', handleSessionEnd);
}

function createEnvironment() {
  const geometry = new THREE.SphereGeometry(200, 32, 32);
  geometry.scale(-1, 1, 1);

  const material = new THREE.MeshBasicMaterial({ color: 0x05070f });
  environmentMesh = new THREE.Mesh(geometry, material);
  scene.add(environmentMesh);

  const light = new THREE.HemisphereLight(0xffffff, 0x334466, 1.1);
  scene.add(light);
}

// In AR mode, clear to transparent and hide the dark backdrop so Quest
// passthrough shows behind the menu/gallery; restore the dark sky otherwise.
function applyPassthrough(isAR) {
  if (isAR) {
    scene.background = null;
    renderer.setClearAlpha(0);
    if (environmentMesh) {
      environmentMesh.visible = false;
    }
  } else {
    scene.background = new THREE.Color(0x03050a);
    renderer.setClearAlpha(1);
    if (environmentMesh) {
      environmentMesh.visible = true;
    }
  }
}

function setupPassthroughToggle() {
  try {
    passthroughEnabled = localStorage.getItem('viewer-passthrough') === '1';
  } catch (error) {
    passthroughEnabled = false;
  }

  const button = document.getElementById('passthroughToggle');
  if (button) {
    button.addEventListener('click', () => {
      passthroughEnabled = !passthroughEnabled;
      try {
        localStorage.setItem('viewer-passthrough', passthroughEnabled ? '1' : '0');
      } catch (error) {
        /* ignore storage failures */
      }
      updatePassthroughToggle();
    });
  }
  updatePassthroughToggle();
}

function updatePassthroughToggle() {
  const button = document.getElementById('passthroughToggle');
  if (!button) {
    return;
  }

  if (xrSupportChecked && !arSupported) {
    button.textContent = 'N/A';
    button.disabled = true;
    return;
  }

  button.disabled = false;
  button.textContent = passthroughEnabled ? 'On' : 'Off';
}

// Floating settings panel (gear button): passthrough, brightness, and a link
// to the bundled Cardboard Camera converter.
function setupSettings() {
  const gear = document.getElementById('settingsButton');
  const panel = document.getElementById('settingsPanel');
  const close = document.getElementById('settingsClose');
  const brightness = document.getElementById('brightness');

  if (gear && panel) {
    gear.addEventListener('click', () => panel.classList.toggle('open'));
  }
  if (close && panel) {
    close.addEventListener('click', () => panel.classList.remove('open'));
  }

  if (brightness) {
    try {
      const saved = parseFloat(localStorage.getItem('viewer-brightness'));
      if (!Number.isNaN(saved)) {
        panoBrightness = saved;
      }
    } catch (error) {
      /* ignore storage failures */
    }
    brightness.value = String(panoBrightness);
    brightness.addEventListener('input', () => {
      panoBrightness = parseFloat(brightness.value) || 1;
      applyBrightness();
      try {
        localStorage.setItem('viewer-brightness', String(panoBrightness));
      } catch (error) {
        /* ignore storage failures */
      }
    });
  }

  setupCropControls();
  setupSuperResControl();
  applyBrightness();
}

// Pole-crop control: Auto (per-image detection) or Manual with a "Crop amount"
// slider, where higher = more removed (kept fraction = 1 - amount).
function setupCropControls() {
  const autoButton = document.getElementById('cropAuto');
  const sliderRow = document.getElementById('cropSliderRow');
  const slider = document.getElementById('cropSlider');

  try {
    cropAuto = localStorage.getItem('viewer-crop-auto') !== '0';
    const savedManual = parseFloat(localStorage.getItem('viewer-crop-manual'));
    if (!Number.isNaN(savedManual)) {
      manualCrop = savedManual;
    }
  } catch (error) {
    /* ignore storage failures */
  }

  if (slider) {
    slider.value = String(1 - manualCrop); // slider shows crop amount
    slider.addEventListener('input', () => {
      const amount = parseFloat(slider.value) || 0;
      manualCrop = Math.min(1, Math.max(0.3, 1 - amount));
      if (!cropAuto) {
        setManualCrop(manualCrop);
      }
      persist('viewer-crop-manual', String(manualCrop));
    });
  }

  if (autoButton) {
    autoButton.addEventListener('click', () => {
      cropAuto = !cropAuto;
      persist('viewer-crop-auto', cropAuto ? '1' : '0');
      refreshCropControls();
    });
  }

  refreshCropControls();

  function refreshCropControls() {
    if (autoButton) {
      autoButton.textContent = cropAuto ? 'Auto' : 'Manual';
    }
    if (sliderRow) {
      sliderRow.style.display = cropAuto ? 'none' : 'flex';
    }

    if (cropAuto) {
      // Re-run detection on the current image (cheap — base texture is cached).
      if (panoGroup?.visible && currentImageIndex >= 0 && !imageLoading) {
        loadStereoImage(imageFiles[currentImageIndex]);
      }
    } else {
      setManualCrop(manualCrop);
    }
  }
}

// Super resolution: framebuffer supersampling. Applied to each new session, so
// changing it takes effect the next time you enter VR (no page reload needed).
function setupSuperResControl() {
  const slider = document.getElementById('superRes');
  if (!slider) {
    return;
  }

  try {
    const saved = parseFloat(localStorage.getItem('viewer-superres'));
    if (!Number.isNaN(saved)) {
      superSample = saved;
    }
  } catch (error) {
    /* ignore storage failures */
  }

  slider.value = String(superSample);
  setSuperSample(superSample);
  slider.addEventListener('input', () => {
    setSuperSample(parseFloat(slider.value) || 1.4);
  });
}

function setSuperSample(value) {
  superSample = value;
  renderer.xr.setFramebufferScaleFactor(superSample);
  persist('viewer-superres', String(superSample));

  const slider = document.getElementById('superRes');
  if (slider && slider.value !== String(superSample)) {
    slider.value = String(superSample);
  }
  const label = document.getElementById('superResValue');
  if (label) {
    label.textContent = `${superSample.toFixed(1)}x`;
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    /* ignore storage failures */
  }
}

// Brightness multiplies the panorama materials' colour (pano only — the menu
// and thumbnails are untouched).
function applyBrightness() {
  [leftSphere, rightSphere].forEach((sphere) => {
    if (sphere?.material?.map) {
      sphere.material.color.setScalar(panoBrightness);
    }
  });
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

  try {
    arSupported = await navigator.xr.isSessionSupported('immersive-ar');
  } catch (error) {
    arSupported = false;
  }

  xrSupportChecked = true;
  updateEnterVRButton();
  updatePassthroughToggle();

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

  // Use an AR (passthrough) session when the toggle is on and supported; the
  // panorama sphere covers passthrough while viewing, so the room only shows
  // behind the gallery/menu.
  const useAR = passthroughEnabled && arSupported;
  const sessionMode = useAR ? 'immersive-ar' : 'immersive-vr';

  // Super resolution only applies to a freshly created session.
  renderer.xr.setFramebufferScaleFactor(superSample);

  let session;
  try {
    // Keep requestSession as the first awaited WebXR call in the click handler so
    // Quest Browser still treats it as a user-initiated action.
    session = await navigator.xr.requestSession(sessionMode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
  } catch (error) {
    console.error(`Unable to start ${sessionMode} session:`, error);
    updateStatus(`Could not enter VR: ${error.message || 'the browser rejected the WebXR session request.'}`);
    return;
  }

  await renderer.xr.setSession(session);
  applyPassthrough(useAR);
  xrSessionActive = true;
  document.getElementById('ui').style.display = 'none';
  enterVRButton.style.display = 'none';
  statusMessage.style.display = 'none';
  document.getElementById('settingsButton')?.style.setProperty('display', 'none');
  document.getElementById('settingsPanel')?.classList.remove('open');

  // Open the most recent image straight away. The thumbnail grid is built
  // lazily the first time it's shown (THUMBNAILS) so we don't decode the whole
  // library at once on entry — that spikes memory and crashes Quest with many
  // images loaded.
  galleryDirty = true;
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

  leftSphere = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  leftSphere.frustumCulled = false;
  leftSphere.layers.set(1); // left eye only

  rightSphere = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  rightSphere.frustumCulled = false;
  rightSphere.layers.set(2); // right eye only

  buildPanoGeometry();

  panoGroup.add(leftSphere, rightSphere);
  scene.add(panoGroup);
}

// Render only the kept latitude band so the blurry padded poles fall outside the
// geometry. cropTop/cropBottom are removed independently, so an image with more
// blur on top than bottom is trimmed correctly (not symmetrically).
function buildPanoGeometry() {
  const thetaStart = Math.PI * cropTop;
  const thetaLength = Math.PI * Math.max(0.1, 1 - cropTop - cropBottom);
  const geometry = new THREE.SphereGeometry(50, 64, 48, 0, Math.PI * 2, thetaStart, thetaLength);
  geometry.scale(-1, 1, 1);

  const previous = leftSphere.geometry;
  leftSphere.geometry = geometry;
  rightSphere.geometry = geometry; // both eyes share one geometry
  if (previous && previous !== geometry) {
    previous.dispose();
  }
}

// Set a symmetric manual kept-fraction and apply it live (rebuild band + re-map).
function setManualCrop(keptFraction) {
  const removed = Math.min(0.8, Math.max(0, 1 - keptFraction));
  cropTop = removed / 2;
  cropBottom = removed / 2;
  applyCropLive();
}

function applyCropLive() {
  buildPanoGeometry();
  if (leftTexture) {
    configureEyeTexture(leftTexture, 'top');
  }
  if (rightTexture) {
    configureEyeTexture(rightTexture, 'bottom');
  }
}

function keptFraction() {
  return 1 - cropTop - cropBottom;
}

function applyPanoTextures(baseTexture) {
  disposePanoTextures();

  // In Auto mode, detect this image's blurry padding (top and bottom measured
  // separately) and crop each end to the sharp content; otherwise keep the
  // manual value. Then rebuild the sphere band.
  if (cropAuto) {
    const detected = detectContentCrop(baseTexture.image);
    cropTop = detected ? detected.top : (1 - DEFAULT_PANO_CROP) / 2;
    cropBottom = detected ? detected.bottom : (1 - DEFAULT_PANO_CROP) / 2;
  }
  buildPanoGeometry();

  // Both eyes are clones of the cached base so the base stays reusable for
  // preloading. Top half of the file -> left eye. (If depth looks inverted on
  // the headset, swap 'top'/'bottom' below.)
  leftTexture = baseTexture.clone();
  configureEyeTexture(leftTexture, 'top');

  rightTexture = baseTexture.clone();
  configureEyeTexture(rightTexture, 'bottom');

  leftSphere.material.map = leftTexture;
  leftSphere.material.color.setScalar(panoBrightness);
  leftSphere.material.needsUpdate = true;

  rightSphere.material.map = rightTexture;
  rightSphere.material.color.setScalar(panoBrightness);
  rightSphere.material.needsUpdate = true;
}

// Estimate the blurry letterbox padding each eye has top and bottom. These
// conversions keep the real panorama as a SHARP band with a fake BLURRY fill
// above/below and a hard line between them. We (1) find the textured "core" via
// horizontal detail (blur has almost none), then (2) above/below the core, the
// blur→content line is the strongest COLOUR step (using RGB, not just
// brightness, so a sky-blur→sky line — similar brightness, different hue — is
// still found), and (3) crop to that line, keeping real sky/ground.
function detectContentCrop(image) {
  try {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) {
      return null;
    }

    const w = 48;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Analyse the top eye (top half of the file) as a representative equirect.
    ctx.drawImage(image, 0, 0, sourceWidth, Math.floor(sourceHeight / 2), 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const meanR = new Float32Array(h);
    const meanG = new Float32Array(h);
    const meanB = new Float32Array(h);
    const hTexture = new Float32Array(h); // horizontal luminance detail (sharpness)
    for (let y = 0; y < h; y += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let edges = 0;
      let prevLum = 0;
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        sr += r;
        sg += g;
        sb += b;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (x > 0) {
          edges += Math.abs(lum - prevLum);
        }
        prevLum = lum;
      }
      meanR[y] = sr / w;
      meanG[y] = sg / w;
      meanB[y] = sb / w;
      hTexture[y] = edges / (w - 1);
    }

    // Core content = rows with real horizontal detail (the blur has almost none).
    let maxTexture = 0;
    for (let y = 0; y < h; y += 1) {
      if (hTexture[y] > maxTexture) {
        maxTexture = hTexture[y];
      }
    }
    if (maxTexture < 2) {
      return null; // whole eye is soft — can't tell, leave it
    }
    const textureThreshold = maxTexture * 0.3;

    let coreTop = -1;
    let coreBottom = -1;
    for (let y = 0; y < h; y += 1) {
      if (hTexture[y] > textureThreshold) {
        coreTop = y;
        break;
      }
    }
    for (let y = h - 1; y >= 0; y -= 1) {
      if (hTexture[y] > textureThreshold) {
        coreBottom = y;
        break;
      }
    }
    if (coreTop < 0 || coreBottom <= coreTop) {
      return null;
    }

    // Colour step between adjacent rows (sum over R,G,B) — catches the line even
    // when blur and content are similar in brightness but differ in hue.
    const colorStep = (y) => Math.abs(meanR[y] - meanR[y - 1]) + Math.abs(meanG[y] - meanG[y - 1]) + Math.abs(meanB[y] - meanB[y - 1]);

    // Baseline = median colour step, so "stands out" adapts to the image.
    const steps = [];
    for (let y = 1; y < h; y += 1) {
      steps.push(colorStep(y));
    }
    steps.sort((a, b) => a - b);
    const medianStep = steps[Math.floor(steps.length / 2)] || 0;
    const minStep = Math.max(10, medianStep * 2.5);

    const boundary = (lo, hi) => {
      let best = -1;
      let bestVal = 0;
      for (let y = Math.max(1, lo); y < hi; y += 1) {
        const g = colorStep(y);
        if (g > bestVal) {
          bestVal = g;
          best = y;
        }
      }
      return { index: best, value: bestVal };
    };

    let top = 0;
    let bottom = 0;
    const topEdge = boundary(2, coreTop);
    if (topEdge.index > 1 && topEdge.value > minStep) {
      top = (topEdge.index + 1) / h;
    }
    const bottomEdge = boundary(coreBottom + 1, h - 1);
    if (bottomEdge.index > 1 && bottomEdge.value > minStep) {
      bottom = (h - bottomEdge.index) / h;
    }

    top = Math.min(0.45, Math.max(0, top));
    bottom = Math.min(0.45, Math.max(0, bottom));
    if (top + bottom > 0.6) {
      const scale = 0.6 / (top + bottom);
      top *= scale;
      bottom *= scale;
    }
    if (top === 0 && bottom === 0) {
      return null;
    }
    return { top, bottom };
  } catch (error) {
    return null; // tainted canvas or read failure — fall back to default
  }
}

function configureEyeTexture(texture, eye) {
  // Select this eye's half of the file, then keep only the [cropTop, cropBottom]
  // band, matching the partial sphere. Derived so cropTop=cropBottom=0 == full.
  const kept = Math.max(0.1, 1 - cropTop - cropBottom);
  const repeatY = 0.5 * kept;
  const offsetY = (eye === 'top' ? 0.5 : 0.0) + 0.5 * cropBottom;

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; // seamless 360° horizontally
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = maxAnisotropy;
  texture.repeat.set(1, repeatY);
  texture.offset.set(0, offsetY);
  texture.needsUpdate = true;
}

function disposePanoTextures() {
  leftSphere.material.map = null;
  rightSphere.material.map = null;
  // These are clones of the cached base; disposing them leaves the base intact.
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
  // placeholder so their order/layout is stable immediately.
  const pending = [];
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const file = files[i];
    const index = i;
    const card = createThumbnailCard(createPlaceholderEyes());

    card.userData.onClick = () => {
      currentImageIndex = index;
      loadStereoImage(file);
    };

    galleryGroup.add(card);
    galleryObjects.push(card);
    interactiveObjects.push(card);
    pending.push({ card, file });
  }

  layoutGallery();

  // Decode the thumbnails ONE AT A TIME (newest/top first). Decoding 15 full
  // images at once is what crashes Quest, so we serialise it.
  fillThumbnailsSequentially(pending);
}

async function fillThumbnailsSequentially(pending) {
  const token = ++thumbBuildToken; // a newer populate cancels this run
  for (const { card, file } of pending) {
    if (token !== thumbBuildToken) {
      return;
    }
    const eyes = await createThumbnailEyes(file).catch(() => null);
    if (token !== thumbBuildToken) {
      return; // gallery was rebuilt/cleared meanwhile
    }
    if (eyes) {
      swapCardEyes(card, eyes);
    }
  }
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
  // Don't dispose the shared placeholder (other cards still use it).
  disposeIfNotShared(leftPlane.material.map);
  disposeIfNotShared(rightPlane.material.map);
  leftPlane.material.map = eyes.left;
  rightPlane.material.map = eyes.right;
  leftPlane.material.needsUpdate = true;
  rightPlane.material.needsUpdate = true;
}

function disposeIfNotShared(texture) {
  if (texture && texture !== sharedPlaceholderTexture) {
    texture.dispose?.();
  }
}

function clearGallery() {
  galleryObjects.forEach((object) => {
    removeInteractiveObject(object);
    galleryGroup.remove(object);
    disposeObject(object);
  });
  galleryObjects.length = 0;
}

function createThumbnailCard(eyes) {
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
  group.userData.defaultScale = new THREE.Vector3(1, 1, 1);
  return group;
}

function createMenu() {
  menuGroup = new THREE.Group();
  menuGroup.visible = false;

  const row = (MENU_BUTTON_HEIGHT + 0.08) / 2;
  const thumbnailsButton = createMenuButton('THUMBNAILS', -0.46, row, 0.84, MENU_BUTTON_HEIGHT);
  const loadAnotherButton = createMenuButton('LOAD ANOTHER', 0.46, row, 0.84, MENU_BUTTON_HEIGHT);
  const settingsButton = createMenuButton('SETTINGS', 0, -row, 0.84, MENU_BUTTON_HEIGHT);

  thumbnailsButton.userData.onClick = showGallery;
  loadAnotherButton.userData.onClick = exitVR;
  settingsButton.userData.onClick = showSettingsMenu;

  [thumbnailsButton, loadAnotherButton, settingsButton].forEach((button) => {
    menuGroup.add(button);
    interactiveObjects.push(button);
  });

  scene.add(menuGroup);
  createSettingsMenu();
}

// In-VR settings: only top/bottom crop, which is the one control that applies
// live. (Super res and passthrough need a fresh session, so they stay on the 2D
// title screen.) +/- buttons since 3D sliders are fiddly to drag.
function createSettingsMenu() {
  settingsMenuGroup = new THREE.Group();
  settingsMenuGroup.visible = false;

  const cropMinus = createMenuButton('–', -0.66, 0.16, 0.34, MENU_BUTTON_HEIGHT);
  vrCropButton = createMenuButton('CROP', 0, 0.16, 0.84, MENU_BUTTON_HEIGHT);
  const cropPlus = createMenuButton('+', 0.66, 0.16, 0.34, MENU_BUTTON_HEIGHT);
  cropMinus.userData.onClick = () => adjustVrCrop(-0.05);
  vrCropButton.userData.onClick = toggleVrCropAuto;
  cropPlus.userData.onClick = () => adjustVrCrop(0.05);

  const backButton = createMenuButton('BACK', 0, -0.16, 0.84, MENU_BUTTON_HEIGHT);
  backButton.userData.onClick = () => {
    hideSettingsMenu();
    showMenu();
  };

  [cropMinus, vrCropButton, cropPlus, backButton].forEach((button) => {
    settingsMenuGroup.add(button);
    interactiveObjects.push(button);
  });

  scene.add(settingsMenuGroup);
}

function showSettingsMenu() {
  menuGroup.visible = false;
  positionGroupInFrontOfCamera(settingsMenuGroup, 1.7);
  settingsMenuGroup.visible = true;
  settingsMenuGroup.scale.setScalar(1);
  setPointerVisibility(true);
  refreshSettingsLabels();
}

function hideSettingsMenu() {
  settingsMenuGroup.visible = false;
}

function refreshSettingsLabels() {
  setMenuButtonText(vrCropButton, cropAuto ? 'CROP: AUTO' : `CROP: ${Math.round((1 - keptFraction()) * 100)}%`);
}

function toggleVrCropAuto() {
  cropAuto = !cropAuto;
  persist('viewer-crop-auto', cropAuto ? '1' : '0');
  syncCropDom();
  if (cropAuto) {
    if (currentImageIndex >= 0 && !imageLoading) {
      loadStereoImage(imageFiles[currentImageIndex]);
    }
  } else {
    setManualCrop(manualCrop);
  }
  refreshSettingsLabels();
}

function adjustVrCrop(deltaAmount) {
  cropAuto = false;
  persist('viewer-crop-auto', '0');
  const amount = Math.min(0.7, Math.max(0, (1 - manualCrop) + deltaAmount));
  manualCrop = 1 - amount;
  persist('viewer-crop-manual', String(manualCrop));
  setManualCrop(manualCrop);
  syncCropDom();
  refreshSettingsLabels();
}

// Keep the 2D settings panel in sync with changes made in VR.
function syncCropDom() {
  const autoButton = document.getElementById('cropAuto');
  const sliderRow = document.getElementById('cropSliderRow');
  const slider = document.getElementById('cropSlider');
  if (autoButton) {
    autoButton.textContent = cropAuto ? 'Auto' : 'Manual';
  }
  if (sliderRow) {
    sliderRow.style.display = cropAuto ? 'none' : 'flex';
  }
  if (slider) {
    slider.value = String(1 - manualCrop);
  }
}

function createMenuButton(text, x, y, width, height) {
  const aspect = width / height;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: createButtonTexture(text, aspect), transparent: true }),
  );

  mesh.position.set(x, y, 0);
  mesh.userData.aspect = aspect;
  mesh.userData.defaultScale = new THREE.Vector3(1, 1, 1);
  return mesh;
}

// Render the button label to a canvas whose aspect matches the button, so the
// pill and text aren't horizontally stretched on wide buttons.
function createButtonTexture(text, aspect = 2.6) {
  const h = 256;
  const w = Math.round(h * aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const pad = 20;
  const x = pad;
  const y = pad;
  const bw = w - pad * 2;
  const bh = h - pad * 2;
  const radius = bh / 2; // pill / stadium shape

  // Soft outer glow.
  ctx.save();
  ctx.shadowColor = 'rgba(50, 110, 190, 0.45)';
  ctx.shadowBlur = 20;
  ctx.fillStyle = 'rgba(18, 24, 34, 0.97)';
  roundRect(ctx, x, y, bw, bh, radius);
  ctx.fill();
  ctx.restore();

  // Body gradient + top highlight, clipped to the pill.
  ctx.save();
  roundRect(ctx, x, y, bw, bh, radius);
  ctx.clip();

  const body = ctx.createLinearGradient(0, y, 0, y + bh);
  body.addColorStop(0, '#30405b');
  body.addColorStop(0.55, '#1c2738');
  body.addColorStop(1, '#121826');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, w, h);

  const highlight = ctx.createLinearGradient(0, y, 0, y + bh * 0.5);
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = highlight;
  ctx.fillRect(0, 0, w, y + bh * 0.5);
  ctx.restore();

  // Crisp light border.
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  roundRect(ctx, x + 1.5, y + 1.5, bw - 3, bh - 3, radius - 1.5);
  ctx.stroke();

  // Label (sized to button height, not width).
  ctx.fillStyle = '#eef5ff';
  ctx.font = `600 ${Math.round(bh * 0.42)}px system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = '3px';
  }
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  ctx.fillText(text, w / 2, h / 2 + 2, bw - 36);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  return texture;
}

// Replace a menu button's label texture (used by the in-VR settings panel).
function setMenuButtonText(mesh, text) {
  const old = mesh.material.map;
  mesh.material.map = createButtonTexture(text, mesh.userData.aspect ?? 2.6);
  mesh.material.needsUpdate = true;
  old?.dispose?.();
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

// Show a message briefly, then hide it (for transient confirmations).
let messageTimer = null;
function flashMessage(text, duration = 1800) {
  showSphereMessage(text);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    loadingText.visible = false;
  }, duration);
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

  if (menuGroup.visible || settingsMenuGroup.visible) {
    hideMenu();
  } else {
    showMenu();
  }
}

function showMenu() {
  if (!xrSessionActive) {
    return;
  }

  hideSettingsMenu();
  positionGroupInFrontOfCamera(menuGroup, 1.7);
  menuGroup.visible = true;
  menuGroup.scale.setScalar(1);
  // Bring the pointer back so the menu buttons can be aimed at.
  setPointerVisibility(true);
}

function hideMenu() {
  menuGroup.visible = false;
  hideSettingsMenu();
  // Hide the pointer again only when we drop back to the clean panorama view.
  if (!galleryGroup.visible && panoGroup.visible) {
    setPointerVisibility(false);
  }
}

function showGallery() {
  // Build (or rebuild) the thumbnails lazily, the first time the grid is opened
  // after the library changed.
  if (galleryDirty) {
    galleryDirty = false;
    populateGallery(imageFiles);
  }

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
  applyPassthrough(false); // restore the dark backdrop for the 2D page
  panoGroup.visible = false;
  galleryGroup.visible = false;
  hideMenu();
  setPointerVisibility(true);
  document.getElementById('ui').style.display = 'flex';
  enterVRButton.style.display = 'block';
  document.getElementById('settingsButton')?.style.setProperty('display', 'block');
  updateEnterVRButton();
  updateLibraryControls();
  clearPanoCache(); // free decoded panoramas when leaving VR

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
    controller.userData.index = i;

    // The targetRaySpace returned by getController does not expose the gamepad
    // directly, so grab the live XRInputSource gamepad (and handedness) from the
    // connect event.
    controller.addEventListener('connected', (event) => {
      controller.userData.gamepad = event.data.gamepad;
      controller.userData.handedness = event.data.handedness;
    });
    controller.addEventListener('disconnected', () => {
      controller.userData.gamepad = null;
    });

    // While viewing a panorama, the trigger flips to the previous/next image
    // (left/right hand). Otherwise it points/clicks the gallery and menu.
    controller.addEventListener('selectstart', () => {
      if (handleViewerTrigger(controller)) {
        return;
      }
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

// When a panorama is on screen (no menu, no grid), the trigger steps through
// the loaded images: left hand -> previous, right hand -> next.
function handleViewerTrigger(controller) {
  if (!xrSessionActive || !panoGroup.visible || menuGroup.visible || settingsMenuGroup.visible || galleryGroup.visible) {
    return false;
  }

  const hand = controller.userData.handedness;
  const isLeft = hand === 'left' || (hand == null && controller.userData.index === 0);
  const isRight = hand === 'right' || (hand == null && controller.userData.index === 1);

  if (isLeft) {
    stepImage(-1, controller);
    return true;
  }
  if (isRight) {
    stepImage(1, controller);
    return true;
  }
  return false;
}

function stepImage(direction, controller) {
  if (imageLoading || imageFiles.length < 2) {
    return;
  }

  const target = currentImageIndex + direction;
  if (target < 0 || target >= imageFiles.length) {
    return; // at the start/end — nothing to do
  }

  currentImageIndex = target;
  pulseController(controller);
  loadStereoImage(imageFiles[target]);
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

function setupInputs() {
  const folderInput = document.getElementById('folderInput');
  const addButton = document.getElementById('addButton');
  const clearButton = document.getElementById('clearButton');

  addButton.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', (event) => handlePickedFiles(event.target.files, event.target));
  clearButton.addEventListener('click', clearLibrary);
}

// Drag-and-drop: Quest's browser supports the HTML5 drop API, so users can open
// the Files app side-by-side and drag a batch of images onto the page — a way
// around the single-file picker. Whole folders are accepted too.
function setupDropZone() {
  const overlay = document.getElementById('dropOverlay');
  const showOverlay = (on) => overlay?.classList.toggle('active', on);

  // dragover must preventDefault on every event or the browser blocks the drop.
  ['dragenter', 'dragover'].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      showOverlay(true);
    });
  });

  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    // Only clear when the pointer actually leaves the window.
    if (!event.relatedTarget) {
      showOverlay(false);
    }
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    showOverlay(false);
    const files = await filesFromDataTransfer(event.dataTransfer);
    if (files.length) {
      handlePickedFiles(files, null);
    }
  });
}

// Collect dropped files, descending into any dropped folders. webkitGetAsEntry
// must be called synchronously during the drop event, so the entries are
// captured up front before any async folder traversal.
async function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }

  const fallbackFiles = dataTransfer.files ? Array.from(dataTransfer.files) : [];

  const entries = [];
  if (dataTransfer.items && dataTransfer.items.length && dataTransfer.items[0].webkitGetAsEntry) {
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }
  }

  if (!entries.length) {
    return fallbackFiles;
  }

  const collected = [];
  for (const entry of entries) {
    await collectEntry(entry, collected);
  }
  return collected.length ? collected : fallbackFiles;
}

function collectEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            resolve();
            return;
          }
          for (const child of batch) {
            await collectEntry(child, out);
          }
          readBatch(); // readEntries returns at most ~100 at a time
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

function isImageFile(file) {
  return (
    file.type.startsWith('image/') ||
    SUPPORTED_IMAGE_TYPES.includes(file.type) ||
    IMAGE_EXTENSIONS.test(file.name)
  );
}

function handlePickedFiles(fileList, inputEl) {
  // Quest's picker only allows one file at a time, so accumulate picks (deduped)
  // across visits instead of replacing. Each new image is also saved to the
  // persistent library so it returns after a reload.
  const existingKeys = new Set(loadedFiles.map(fileKey));
  Array.from(fileList).forEach((file) => {
    if (isImageFile(file) && !existingKeys.has(fileKey(file))) {
      loadedFiles.push(file);
      existingKeys.add(fileKey(file));
      persistImage(file);
    }
  });

  imageFiles = loadedFiles.filter(isImageFile);
  galleryDirty = true;

  if (inputEl) {
    inputEl.value = ''; // allow re-picking the same file/folder next time
  }

  updateEnterVRButton();
  updateLibraryControls();

  if (!imageFiles.length) {
    updateStatus('No supported images were found. Select a top/bottom stereo 360 image (JPG or PNG).');
    return;
  }

  if (xrSupportChecked && !xrSupported) {
    updateStatus('Image added, but immersive VR is not available in this browser. On Quest 3, use Meta Quest Browser over HTTPS.');
    return;
  }

  // The Enter VR button already shows the count, so no extra "ready" text.
  updateStatus('');
}

function updateLibraryControls() {
  const clearButton = document.getElementById('clearButton');
  if (clearButton) {
    clearButton.style.display = loadedFiles.length ? 'block' : 'none';
  }
}

async function clearLibrary() {
  loadedFiles = [];
  imageFiles = [];
  currentImageIndex = -1;
  galleryDirty = true;
  clearPanoCache();
  await idbClear().catch(() => {});
  updateEnterVRButton();
  updateLibraryControls();
  updateStatus('Saved library cleared. Choose images to begin.');
}

// ---- Persistent library (IndexedDB) -------------------------------------
const DB_NAME = 'VieweRDB';
const DB_STORE = 'images';
let dbPromise = null;

function openDB() {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function persistImage(file) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({
        id: fileKey(file),
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        savedAt: Date.now(),
        blob: file,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn('Could not save image to the library:', error);
  }
}

async function idbClear() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function restoreLibrary() {
  let records;
  try {
    const db = await openDB();
    records = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return; // no persistence available — nothing to restore
  }

  if (!records.length) {
    return;
  }

  records.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));

  const existingKeys = new Set(loadedFiles.map(fileKey));
  records.forEach((record) => {
    const file = new File([record.blob], record.name, {
      type: record.type,
      lastModified: record.lastModified,
    });
    if (!existingKeys.has(fileKey(file))) {
      loadedFiles.push(file);
      existingKeys.add(fileKey(file));
    }
  });

  imageFiles = loadedFiles.filter(isImageFile);
  galleryDirty = true;
  updateEnterVRButton();
  updateLibraryControls();
}

// Stable identity for a picked File so the same image isn't added twice.
function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// Build a stereo pair of thumbnail textures (top half -> left eye, bottom half
// -> right eye) so each card previews in 3D, matching the main viewer.
// Decodes the image DOWNSCALED (~1024px wide) so a big library doesn't exhaust
// memory — thumbnails don't need full resolution.
async function createThumbnailEyes(file) {
  // Preferred path: decode straight to a small bitmap (low memory).
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { resizeWidth: 1920, resizeQuality: 'medium' });
      const eyes = {
        left: halfTexture(bitmap, bitmap.width, bitmap.height, 'top'),
        right: halfTexture(bitmap, bitmap.width, bitmap.height, 'bottom'),
      };
      bitmap.close?.();
      return eyes;
    } catch (error) {
      /* fall back to <img> below */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      left: halfTexture(image, image.naturalWidth, image.naturalHeight, 'top'),
      right: halfTexture(image, image.naturalWidth, image.naturalHeight, 'bottom'),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function halfTexture(source, width, height, which) {
  // Canvas matches the card's aspect so the cropped strip fills it.
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 278;
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
  texture.anisotropy = maxAnisotropy;
  return texture;
}

// Fallback eye pair for images the browser can't decode (e.g. HEIC).
// One shared placeholder texture for every pending card, so a big grid doesn't
// allocate dozens of canvases before the real thumbnails decode.
let sharedPlaceholderTexture = null;

function createPlaceholderEyes() {
  if (!sharedPlaceholderTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1b2733';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading…', canvas.width / 2, canvas.height / 2);
    sharedPlaceholderTexture = new THREE.CanvasTexture(canvas);
    sharedPlaceholderTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return { left: sharedPlaceholderTexture, right: sharedPlaceholderTexture };
}

async function loadStereoImage(imageFile) {
  galleryGroup.visible = false;
  hideMenu();
  showSphereMessage('Loading panorama…');
  imageLoading = true;

  // Start every panorama facing forward.
  sphereTargetRotationY = 0;
  panoGroup.rotation.y = 0;

  try {
    const baseTexture = await getBaseTexture(imageFile);

    applyPanoTextures(baseTexture);
    panoGroup.visible = true;
    loadingText.visible = false;
    playMatchingAudio(imageFile.name);
    // Clean, control-free view while looking at the panorama.
    setPointerVisibility(false);
    // Decode the neighbours in the background so trigger-stepping is instant.
    preloadNeighbours();
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
      positionGroupInFrontOfCamera(galleryGroup, 3.0);
    }
  } finally {
    imageLoading = false;
  }
}

// Cache of decoded base textures keyed by fileKey, holding the promise so
// concurrent requests share one decode. Eye textures are cloned from these, so
// a cached base can be reused instantly when stepping back to an image.
const panoCache = new Map();

function getBaseTexture(imageFile) {
  const key = fileKey(imageFile);
  if (!panoCache.has(key)) {
    panoCache.set(
      key,
      buildPanoTexture(imageFile).catch((error) => {
        panoCache.delete(key); // don't cache failures
        throw error;
      }),
    );
  }
  return panoCache.get(key);
}

// Keep only the current image and its immediate neighbours decoded; kick off
// the neighbours' decode and dispose anything outside that window.
function preloadNeighbours() {
  if (imageFiles.length < 2) {
    return;
  }

  const keep = new Set();
  for (let d = -1; d <= 1; d += 1) {
    const j = currentImageIndex + d;
    if (j >= 0 && j < imageFiles.length) {
      const file = imageFiles[j];
      keep.add(fileKey(file));
      getBaseTexture(file).catch(() => {});
    }
  }

  for (const [key, value] of panoCache) {
    if (!keep.has(key)) {
      panoCache.delete(key);
      Promise.resolve(value).then((texture) => texture?.dispose?.()).catch(() => {});
    }
  }
}

function clearPanoCache() {
  for (const value of panoCache.values()) {
    Promise.resolve(value).then((texture) => texture?.dispose?.()).catch(() => {});
  }
  panoCache.clear();
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
        // Don't close the bitmap: the texture (and its eye clones) reference it
        // until the GPU upload happens on first render.
        return imageToTexture(bitmap, bitmap.width, bitmap.height, maxSize);
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
  camera.getWorldPosition(tempPosition);
  camera.getWorldDirection(tempDirection);

  // Flatten to the horizontal heading (ignore head pitch/roll) so the panel is
  // always level, at eye height, and squarely in front — not tilted or offset
  // by where the head happened to be pointing.
  tempDirection.y = 0;
  if (tempDirection.lengthSq() < 1e-4) {
    tempDirection.set(0, 0, -1);
  }
  tempDirection.normalize();

  group.position.copy(tempPosition).addScaledVector(tempDirection, distance);
  group.position.y = tempPosition.y;
  group.lookAt(tempPosition.x, tempPosition.y, tempPosition.z);
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
      disposeIfNotShared(child.material?.map); // keep the shared placeholder alive
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
