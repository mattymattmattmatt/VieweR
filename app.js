import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

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

// Flat (-2D) panoramas are shown on a curved arc in front of the viewer whose
// horizontal:vertical angular size matches the image's width:height (so pixels
// stay square and nothing is stretched). We can't know the real capture FOV, so
// we assume a comfortable vertical FOV and derive the horizontal arc from the
// image's aspect ratio. flatPanoAspect is the current flat image's width/height.
const FLAT_PANO_VFOV = THREE.MathUtils.degToRad(55);
let flatPanoAspect = 2;

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
// Uniform scale of the panorama spheres. For a 360 pano the eye sits at the
// sphere centre, so this changes the STEREO depth/scale (smaller sphere = more
// parallax = world feels closer/smaller), not the mono image. 1.0 = default.
let panoScale = 1;
let panoGroup;
let leftSphere;
let rightSphere;
let leftTexture = null;
let rightTexture = null;
let panoLayersReady = false;
// How the current image is displayed, from its filename:
//   'stereo' (default) — over-under: top half -> left eye, bottom -> right (3D)
//   '2d'    (-2D tag)   — flat: whole image to both eyes, no depth
//   'sphere'(-SPHERE)   — flat full 360 sphere (no pole cropping)
let currentPanoMode = 'stereo';
let galleryGroup;
let galleryUpArrow;
let galleryDownArrow;
let galleryScroll = 0;
let galleryDirty = true;
let thumbBuildToken = 0;
let menuGroup;
let settingsMenuGroup;
let vrCropButton;
let vrScaleButton;
let loadingText;
let statusMessage;
let enterVRButton;
let infoPanel;

// Capture-date info panel (toggled with the A/X button). Dates are read from the
// loaded JPEG's raw bytes once and cached by fileKey.
const infoCache = new Map();
let currentImageDate = null;

const controllers = [];
const grips = [];
const hands = [];

// How far the laser reaches when it isn't resting on a button/thumbnail.
const POINTER_REACH = 6;
// Start the beam a few cm ahead of the ray origin so it doesn't visually pierce
// the controller model / the hand.
const POINTER_START = 0.035;
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
  createInfoPanel();
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
  setupScaleControl();
  applyBrightness();
}

// Panorama scale: resizes the stereo spheres to dial the perceived depth/scale
// of the 3D scene. Applies live (no fresh session needed).
function setupScaleControl() {
  const slider = document.getElementById('panoScale');

  try {
    const saved = parseFloat(localStorage.getItem('viewer-pano-scale'));
    if (!Number.isNaN(saved)) {
      panoScale = saved;
    }
  } catch (error) {
    /* ignore storage failures */
  }

  if (slider) {
    slider.value = String(panoScale);
    slider.addEventListener('input', () => setPanoScale(parseFloat(slider.value) || 1));
  }

  applyPanoScale();
  updateScaleLabel();
}

function setPanoScale(value) {
  panoScale = Math.min(1.5, Math.max(0.5, Math.round(value * 100) / 100));
  applyPanoScale();
  persist('viewer-pano-scale', String(panoScale));

  const slider = document.getElementById('panoScale');
  if (slider && slider.value !== String(panoScale)) {
    slider.value = String(panoScale);
  }
  updateScaleLabel();
}

function applyPanoScale() {
  if (panoGroup) {
    panoGroup.scale.setScalar(panoScale);
  }
}

function updateScaleLabel() {
  const label = document.getElementById('panoScaleValue');
  if (label) {
    label.textContent = `${panoScale.toFixed(2)}x`;
  }
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
// Horizontal/vertical arc (radians) for a flat pano of the given aspect, with
// square pixels. We fix the vertical FOV and scale the horizontal arc by aspect;
// if that would exceed a full turn, clamp it and shrink the vertical to match.
function flatPanoArc(aspect) {
  let theta = FLAT_PANO_VFOV;
  let phi = theta * aspect;
  if (phi > Math.PI * 2) {
    phi = Math.PI * 2;
    theta = phi / aspect;
  }
  return { phi, theta };
}

function buildPanoGeometry() {
  let geometry;
  if (currentPanoMode === 'sphere') {
    // True 360 equirect -> full sphere.
    geometry = new THREE.SphereGeometry(50, 64, 48, 0, Math.PI * 2, 0, Math.PI);
  } else if (currentPanoMode === '2d') {
    // Flat pano -> a curved arc centred in front of the viewer (-Z), sized to
    // the image aspect so it isn't stretched. Nothing is cropped.
    const { phi, theta } = flatPanoArc(flatPanoAspect);
    const phiStart = -Math.PI / 2 - phi / 2; // centre the arc on forward
    const thetaStart = (Math.PI - theta) / 2; // centre it on the equator
    geometry = new THREE.SphereGeometry(50, 96, 48, phiStart, phi, thetaStart, theta);
  } else {
    // Over-under stereo (default): full 360 wrap, vertical band from the crop.
    const thetaStart = Math.PI * cropTop;
    const thetaLength = Math.PI * Math.max(0.1, 1 - cropTop - cropBottom);
    geometry = new THREE.SphereGeometry(50, 64, 48, 0, Math.PI * 2, thetaStart, thetaLength);
  }
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
  mapPanoTextures();
}

function keptFraction() {
  return 1 - cropTop - cropBottom;
}

// Decide how a file is shown from its name. A "-2D" tag means a flat (mono)
// panorama; "-SPHERE" means a flat full 360 sphere. Anything else is treated as
// the over-under stereo the app was built for (unchanged behaviour).
function detectPanoMode(name) {
  const n = String(name || '');
  if (/-sphere(?=[-_. ]|$)/i.test(n)) {
    return 'sphere';
  }
  if (/-2d(?=[-_. ]|$)/i.test(n)) {
    return '2d';
  }
  return 'stereo';
}

// Map the current eye textures according to the pano mode. Stereo splits the
// file into top/bottom halves (one per eye); the flat modes show the whole
// image to BOTH eyes, so there's no parallax and therefore no depth.
function mapPanoTextures() {
  if (currentPanoMode === 'stereo') {
    if (leftTexture) {
      configureEyeTexture(leftTexture, 'top');
    }
    if (rightTexture) {
      configureEyeTexture(rightTexture, 'bottom');
    }
  } else {
    if (leftTexture) {
      configureEyeTexture(leftTexture, 'full');
    }
    if (rightTexture) {
      configureEyeTexture(rightTexture, 'full');
    }
  }
}

function applyPanoTextures(baseTexture) {
  disposePanoTextures();

  if (currentPanoMode === 'sphere') {
    // A true 360 sphere fills the whole vertical FOV — no pole cropping.
    cropTop = 0;
    cropBottom = 0;
  } else if (currentPanoMode === '2d') {
    // Flat pano: no crop; the arc geometry handles the aspect instead.
    cropTop = 0;
    cropBottom = 0;
    const img = baseTexture.image;
    const w = img?.naturalWidth || img?.width || 2;
    const h = img?.naturalHeight || img?.height || 1;
    flatPanoAspect = h > 0 ? w / h : 2;
  } else if (cropAuto) {
    // In Auto mode, detect this image's blurry padding (top and bottom measured
    // separately) and crop each end to the sharp content; otherwise keep the
    // manual value. Flat panos are analysed over the full frame; stereo over one
    // eye (top half), which represents the same scene.
    const detected = detectContentCrop(baseTexture.image, currentPanoMode !== 'stereo');
    cropTop = detected ? detected.top : (1 - DEFAULT_PANO_CROP) / 2;
    cropBottom = detected ? detected.bottom : (1 - DEFAULT_PANO_CROP) / 2;
  }
  buildPanoGeometry();

  // Both eyes are clones of the cached base so the base stays reusable for
  // preloading. mapPanoTextures handles the per-mode split. (If stereo depth
  // looks inverted on the headset, swap 'top'/'bottom' in mapPanoTextures.)
  leftTexture = baseTexture.clone();
  rightTexture = baseTexture.clone();
  mapPanoTextures();

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
function detectContentCrop(image, analyzeFull) {
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
    // Stereo: analyse the top eye (top half of the file) as a representative
    // equirect. Flat panos: analyse the whole frame (it IS the scene).
    const regionHeight = analyzeFull ? sourceHeight : Math.floor(sourceHeight / 2);
    ctx.drawImage(image, 0, 0, sourceWidth, regionHeight, 0, 0, w, h);
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
  // Keep only the [cropTop, cropBottom] band, matching the partial sphere.
  // 'top'/'bottom' select an eye-half of an over-under file (stereo); 'full'
  // maps the whole image (flat 2D / sphere — same to both eyes, so no depth).
  const kept = Math.max(0.1, 1 - cropTop - cropBottom);
  // 'full' (flat 2D / sphere) always maps the whole image — the arc/sphere
  // geometry handles its shape, so crop values don't apply.
  const repeatY = eye === 'full' ? 1 : 0.5 * kept;
  const offsetY = eye === 'full' ? 0 : (eye === 'top' ? 0.5 : 0.0) + 0.5 * cropBottom;

  texture.colorSpace = THREE.SRGBColorSpace;
  // 360 modes wrap seamlessly; the flat 2D arc doesn't (it ends at the edges).
  texture.wrapS = currentPanoMode === '2d' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
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

// In-VR settings: top/bottom crop and panorama scale, both of which apply live.
// (Super res and passthrough need a fresh session, so they stay on the 2D title
// screen.) +/- buttons since 3D sliders are fiddly to drag. Tapping the middle
// CROP/SCALE label resets that control (crop toggles Auto; scale -> 1.0x).
function createSettingsMenu() {
  settingsMenuGroup = new THREE.Group();
  settingsMenuGroup.visible = false;

  const cropMinus = createMenuButton('–', -0.66, 0.30, 0.34, MENU_BUTTON_HEIGHT);
  vrCropButton = createMenuButton('CROP', 0, 0.30, 0.84, MENU_BUTTON_HEIGHT);
  const cropPlus = createMenuButton('+', 0.66, 0.30, 0.34, MENU_BUTTON_HEIGHT);
  cropMinus.userData.onClick = () => adjustVrCrop(-0.05);
  vrCropButton.userData.onClick = toggleVrCropAuto;
  cropPlus.userData.onClick = () => adjustVrCrop(0.05);

  const scaleMinus = createMenuButton('–', -0.66, 0.04, 0.34, MENU_BUTTON_HEIGHT);
  vrScaleButton = createMenuButton('SCALE', 0, 0.04, 0.84, MENU_BUTTON_HEIGHT);
  const scalePlus = createMenuButton('+', 0.66, 0.04, 0.34, MENU_BUTTON_HEIGHT);
  scaleMinus.userData.onClick = () => adjustVrScale(-0.05);
  vrScaleButton.userData.onClick = () => adjustVrScale(0); // reset to 1.0x
  scalePlus.userData.onClick = () => adjustVrScale(0.05);

  const backButton = createMenuButton('BACK', 0, -0.24, 0.84, MENU_BUTTON_HEIGHT);
  backButton.userData.onClick = () => {
    hideSettingsMenu();
    showMenu();
  };

  [cropMinus, vrCropButton, cropPlus, scaleMinus, vrScaleButton, scalePlus, backButton].forEach((button) => {
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
  setMenuButtonText(vrScaleButton, `SCALE: ${panoScale.toFixed(2)}x`);
}

// In-VR scale step. A zero delta resets to 1.0x (tapping the middle label).
function adjustVrScale(delta) {
  setPanoScale(delta === 0 ? 1 : panoScale + delta);
  refreshSettingsLabels();
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

// A small floating panel showing the photo's capture date, toggled with the
// A/X button. It lives on its own (not in interactiveObjects) since it's purely
// informational — no laser interaction needed.
function createInfoPanel() {
  infoPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.5),
    new THREE.MeshBasicMaterial({ map: createInfoTexture('Photo info', 'No details'), transparent: true }),
  );
  infoPanel.renderOrder = 21; // above the panorama and loading text
  infoPanel.visible = false;
  scene.add(infoPanel);
}

function toggleInfoPanel() {
  if (!xrSessionActive || !infoPanel) {
    return;
  }
  if (infoPanel.visible) {
    infoPanel.visible = false;
    return;
  }
  refreshInfoPanel();
  positionGroupInFrontOfCamera(infoPanel, 1.4);
  infoPanel.visible = true;
}

// Rebuild the panel's texture from the current image's capture date.
function refreshInfoPanel() {
  if (!infoPanel) {
    return;
  }
  let body;
  if (currentImageDate === 'pending') {
    body = 'Reading…';
  } else if (currentImageDate) {
    body = formatCaptureDate(currentImageDate);
  } else {
    body = 'No date recorded';
  }
  const previous = infoPanel.material.map;
  infoPanel.material.map = createInfoTexture('Captured', body);
  infoPanel.material.needsUpdate = true;
  previous?.dispose?.();
}

// Read the capture date for the image being shown, cache it, and refresh the
// panel if it's open. Reads are from the file's raw bytes, independent of the
// pixel decode used for the panorama.
async function updateCurrentImageInfo(imageFile) {
  const key = fileKey(imageFile);
  if (infoCache.has(key)) {
    currentImageDate = infoCache.get(key);
    if (infoPanel?.visible) {
      refreshInfoPanel();
    }
    return;
  }

  currentImageDate = 'pending';
  if (infoPanel?.visible) {
    refreshInfoPanel();
  }

  const date = await resolveCaptureDate(imageFile).catch(() => null);
  infoCache.set(key, date);
  // Only adopt the result if we're still on the same image.
  if (currentImageIndex >= 0 && fileKey(imageFiles[currentImageIndex]) === key) {
    currentImageDate = date;
    if (infoPanel?.visible) {
      refreshInfoPanel();
    }
  }
}

// Pick the best capture date for a file. The embedded metadata (EXIF/XMP) may
// be the date the file was COPIED onto the headset rather than when it was
// taken, but camera filenames (e.g. IMG_20170610_160948...) carry the real
// capture time. When both exist we keep the EARLIER one — a later metadata date
// is almost always a copy timestamp. Returns a Date or null.
async function resolveCaptureDate(file) {
  const metaDate = parseDateValue(await readCaptureDate(file).catch(() => null));
  const nameDate = parseFilenameDate(file.name);
  if (metaDate && nameDate) {
    return metaDate.getTime() <= nameDate.getTime() ? metaDate : nameDate;
  }
  return metaDate || nameDate || null;
}

// Pull a date out of common camera filename patterns, e.g.
// "IMG_20170610_160948", "VID_20170610_160948", "PANO_20170610_160948" or a
// bare "20170610_160948"/"20170610". Returns a Date or null.
function parseFilenameDate(name) {
  const m = name.match(/(20\d{2}|19\d{2})(\d{2})(\d{2})(?:[ _\-T]?(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  const s = Number(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createInfoTexture(heading, body) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 348;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(12, 18, 28, 0.92)';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 32);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(120, 180, 255, 0.35)';
  roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, 30);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = 'rgba(150, 200, 255, 0.85)';
  ctx.font = '600 40px system-ui, "Segoe UI", Roboto, sans-serif';
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = '4px';
  }
  ctx.fillText(heading.toUpperCase(), canvas.width / 2, 96);

  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = '0px';
  }
  ctx.fillStyle = '#eef5ff';
  ctx.font = '600 54px system-ui, "Segoe UI", Roboto, sans-serif';
  const lines = wrapText(ctx, body, canvas.width - 90);
  const lineHeight = 64;
  const startY = 210 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, startY + index * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

// Format a Date into a readable capture label.
function formatCaptureDate(date) {
  try {
    return date.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (error) {
    return String(date);
  }
}

function parseDateValue(raw) {
  if (!raw) {
    return null;
  }
  // EXIF date: "YYYY:MM:DD HH:MM:SS" -> ISO-ish.
  const exif = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (exif) {
    const [, y, mo, d, h, mi, s] = exif;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Read a capture date from a JPEG's APP1 segments — EXIF (DateTimeOriginal /
// DateTime) first, then XMP (exif:DateTimeOriginal / xmp:CreateDate /
// photoshop:DateCreated / GPano:FirstPhotoDate). Returns null for non-JPEGs or
// when no date is present.
async function readCaptureDate(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null; // not a JPEG
  }

  let xmpDate = null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break; // start of scan / end of image — no more metadata
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) {
      break;
    }
    const segStart = offset + 4;
    const segEnd = offset + 2 + length;

    if (marker === 0xe1) {
      if (asciiAt(bytes, segStart, 4) === 'Exif') {
        const exifDate = parseExifDate(bytes, segStart + 6); // skip "Exif\0\0"
        if (exifDate) {
          return exifDate; // EXIF wins outright
        }
      } else if (!xmpDate) {
        xmpDate = parseXmpDate(bytesToString(bytes, segStart, segEnd));
      }
    }
    offset = segEnd;
  }
  return xmpDate;
}

function asciiAt(bytes, start, count) {
  let s = '';
  for (let i = 0; i < count && start + i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[start + i]);
  }
  return s;
}

function bytesToString(bytes, start, end) {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function parseXmpDate(xml) {
  const keys = ['exif:DateTimeOriginal', 'xmp:CreateDate', 'photoshop:DateCreated', 'GPano:FirstPhotoDate', 'GPano:LastPhotoDate'];
  for (const key of keys) {
    // Match both attribute form (key="...") and element form (<key>...</key>).
    const attr = xml.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
    if (attr) {
      return attr[1];
    }
    const elem = xml.match(new RegExp(`<${key}>([^<]+)</${key}>`));
    if (elem) {
      return elem[1];
    }
  }
  return null;
}

// Minimal EXIF/TIFF walk: read DateTimeOriginal (0x9003) from the Exif sub-IFD,
// falling back to DateTime (0x0132) in IFD0. `base` points at the TIFF header.
function parseExifDate(bytes, base) {
  try {
    if (base + 8 > bytes.length) {
      return null;
    }
    const little = asciiAt(bytes, base, 2) === 'II';
    const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
    const u32 = (o) => (little
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);

    const readAscii = (valueOffset, count) => {
      let s = '';
      for (let i = 0; i < count - 1 && base + valueOffset + i < bytes.length; i += 1) {
        const c = bytes[base + valueOffset + i];
        if (c === 0) {
          break;
        }
        s += String.fromCharCode(c);
      }
      return s;
    };

    const ifd0Offset = u32(base + 4);
    let dateTime = null;
    let exifIfdOffset = 0;

    const walkIfd = (ifdOffset, wantTags) => {
      const found = {};
      const entryBase = base + ifdOffset;
      if (entryBase + 2 > bytes.length) {
        return found;
      }
      const count = u16(entryBase);
      for (let i = 0; i < count; i += 1) {
        const entry = entryBase + 2 + i * 12;
        if (entry + 12 > bytes.length) {
          break;
        }
        const tag = u16(entry);
        if (!wantTags.includes(tag)) {
          continue;
        }
        const type = u16(entry + 2);
        const num = u32(entry + 4);
        if (type === 2) {
          // ASCII: inline when <=4 bytes, else at the offset.
          const valueOffset = num <= 4 ? entry + 8 - base : u32(entry + 8);
          found[tag] = readAscii(valueOffset, num);
        } else {
          found[tag] = u32(entry + 8); // pointer (e.g. Exif IFD)
        }
      }
      return found;
    };

    const ifd0 = walkIfd(ifd0Offset, [0x0132, 0x8769]);
    if (ifd0[0x0132]) {
      dateTime = ifd0[0x0132];
    }
    exifIfdOffset = ifd0[0x8769] || 0;

    if (exifIfdOffset) {
      const exifIfd = walkIfd(exifIfdOffset, [0x9003, 0x9004]);
      if (exifIfd[0x9003]) {
        return exifIfd[0x9003]; // DateTimeOriginal
      }
      if (exifIfd[0x9004]) {
        return exifIfd[0x9004]; // DateTimeDigitized
      }
    }
    return dateTime;
  } catch (error) {
    return null;
  }
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
  if (infoPanel) {
    infoPanel.visible = false;
  }
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
  const modelFactory = new XRControllerModelFactory();

  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.userData.stickActive = false;
    controller.userData.menuPressed = false;
    controller.userData.infoPressed = false;
    controller.userData.index = i;

    // The targetRaySpace returned by getController does not expose the gamepad
    // directly, so grab the live XRInputSource gamepad (and handedness) from the
    // connect event.
    controller.addEventListener('connected', (event) => {
      controller.userData.gamepad = event.data.gamepad;
      controller.userData.handedness = event.data.handedness;
      controller.userData.isHand = !!event.data.hand;
    });
    controller.addEventListener('disconnected', () => {
      controller.userData.gamepad = null;
      controller.userData.isHand = false;
    });

    // While viewing a panorama, the trigger flips to the previous/next image
    // (left/right hand). Otherwise it points/clicks the gallery and menu.
    // Hand pinches also raise this event, but we handle those in handleHand so
    // pinch can't double-fire (step image AND toggle menu) — bail here for hands.
    controller.addEventListener('selectstart', () => {
      if (controller.userData.isHand) {
        return;
      }
      if (handleViewerTrigger(controller)) {
        return;
      }
      clickFromRay(controller);
    });

    const pointer = createPointer();
    controller.add(pointer);
    controller.userData.pointer = pointer;

    scene.add(controller);
    controllers.push(controller);

    // The grip space carries the physical Touch controller model. The factory
    // loads the correct mesh for whatever hardware reports in (Quest 3's
    // Touch Plus controllers included) from the WebXR input-profiles CDN.
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(modelFactory.createControllerModel(grip));
    scene.add(grip);
    grips.push(grip);
  }
}

// A laser pointer: a thin tapered beam plus a ring reticle that rests on
// whatever the beam touches. Both live under the controller's target-ray space
// and point down -Z.
function createPointer() {
  const group = new THREE.Group();
  group.name = 'pointer';

  // Tapered cylinder: thicker at the controller, fading to a fine tip. Built
  // length 1 along -Z so we can scale.z to the live reach each frame.
  const beamGeo = new THREE.CylinderGeometry(0.0016, 0.0042, 1, 12, 1, true);
  beamGeo.rotateX(-Math.PI / 2); // +Y -> -Z
  beamGeo.translate(0, 0, -0.5); // base at origin, tip at z = -1
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.renderOrder = 5;
  group.add(beam);
  group.userData.beam = beam;

  const reticleMat = new THREE.MeshBasicMaterial({
    color: 0x9be0ff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.02, 28), reticleMat);
  reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.006, 20), reticleMat));
  reticle.renderOrder = 6;
  reticle.visible = false;
  group.add(reticle);
  group.userData.reticle = reticle;

  return group;
}

// Stretch the beam to the hovered target (so it visually stops at the button
// surface) and park the reticle on it. With no hit, the beam reaches its full
// length and the reticle hides.
function updatePointer(controller, hit) {
  const pointer = controller.userData.pointer;
  if (!pointer || !pointer.visible) {
    return;
  }
  const reach = hit ? hit.distance : POINTER_REACH;
  // Emerge the beam a little ahead of the origin so it doesn't clip through the
  // controller/hand; the tip still lands on the hit point.
  const start = Math.min(POINTER_START, reach * 0.5);
  const beam = pointer.userData.beam;
  beam.scale.z = Math.max(0.001, reach - start);
  beam.position.z = -start;
  const reticle = pointer.userData.reticle;
  if (hit) {
    reticle.visible = true;
    reticle.position.set(0, 0, -reach);
  } else {
    reticle.visible = false;
  }
}

function setPointerVisibility(visible) {
  controllers.forEach((controller) => {
    const pointer = controller.userData.pointer;
    if (pointer) {
      pointer.visible = visible;
    }
  });
  // Show the physical controller models alongside the laser, hide them with it
  // for a clean view while a panorama fills the headset.
  grips.forEach((grip) => {
    grip.visible = visible;
  });
}

function setupHands() {
  const factory = new XRHandModelFactory();

  for (let i = 0; i < 2; i += 1) {
    const hand = renderer.xr.getHand(i);
    hand.add(factory.createHandModel(hand, 'mesh'));
    hand.userData.isPinching = false;
    hand.userData.index = i; // pairs with controllers[i] (same input source)
    scene.add(hand);
    hands.push(hand);
  }
}

// Pinch detection with hysteresis: engage when the index/thumb tips close to
// 2cm, release once they open past 3cm. Returns true only on the engage edge,
// so a single pinch fires exactly one action (no jitter / repeats).
function pinchEngaged(hand) {
  const indexTip = hand.joints['index-finger-tip'];
  const thumbTip = hand.joints['thumb-tip'];
  if (!indexTip || !thumbTip) {
    return false;
  }

  const distance = indexTip.position.distanceTo(thumbTip.position);
  if (hand.userData.isPinching) {
    if (distance > 0.03) {
      hand.userData.isPinching = false;
    }
    return false;
  }
  if (distance < 0.02) {
    hand.userData.isPinching = true;
    return true; // rising edge
  }
  return false;
}

function handleHand(hand) {
  // Hover + the visible laser are driven by handleController along the hand's
  // system pointing ray (the same ray the beam shows). Here we only turn a pinch
  // into a click on whatever that ray is resting on, so selection matches the
  // beam — much easier to aim than the old fingertip-direction ray.
  if (!hand.joints || !hand.joints['index-finger-tip']) {
    return;
  }
  if (!pinchEngaged(hand)) {
    return;
  }

  const controller = controllers[hand.userData.index];
  if (!controller) {
    return;
  }

  // clickFromRay aims along the controller/hand target ray and clicks the hovered
  // target, returning false if nothing was hit. Hands have no B/Y button, so an
  // empty pinch toggles the menu: it opens from the clean panorama view and
  // closes an open menu. (Skipped while the thumbnail grid is up, where an empty
  // pinch shouldn't pop the menu over it.)
  if (!clickFromRay(controller)) {
    if (menuGroup.visible || settingsMenuGroup.visible || !galleryGroup.visible) {
      toggleMenu();
    }
  }
}

function handleController(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hit = updateHoverState();
  updatePointer(controller, hit);
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

  // A / X face button (xr-standard index 4) toggles the photo-info panel.
  const infoPressed = gamepad.buttons[4]?.pressed ?? false;
  if (infoPressed && !controller.userData.infoPressed) {
    toggleInfoPanel();
    pulseController(controller);
  }
  controller.userData.infoPressed = infoPressed;

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

  // Bulk import from a single .zip — one file pick instead of 300.
  const addZipButton = document.getElementById('addZipButton');
  const zipInput = document.getElementById('zipInput');
  if (addZipButton && zipInput) {
    addZipButton.addEventListener('click', () => zipInput.click());
    zipInput.addEventListener('change', (event) => {
      handleZipInput(event.target.files);
      event.target.value = ''; // allow re-importing the same pack later
    });
  }
}

// Import one or more .zip packs of images. Extracted images flow through the
// same path as picked files (dedup, IndexedDB persistence, gallery rebuild,
// filename-date + 2D/sphere detection), so a single pick replaces hundreds and
// the images also survive a reload — no need to re-import.
async function handleZipInput(fileList) {
  const zips = Array.from(fileList || []).filter(isZipFile);
  for (const zip of zips) {
    await importZip(zip);
  }
}

function isZipFile(file) {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

async function importZip(file) {
  if (typeof JSZip === 'undefined') {
    updateStatus('ZIP support could not load (no connection to the JSZip library). Check your internet and reload the page.');
    return;
  }

  updateStatus(`Opening ${file.name}…`);
  let archive;
  try {
    archive = await JSZip.loadAsync(file);
  } catch (error) {
    updateStatus(`Couldn't read ${file.name} — is it a valid .zip?`);
    return;
  }

  // Collect image entries; skip folders, macOS resource forks and hidden dotfiles.
  const entries = [];
  archive.forEach((path, entry) => {
    if (entry.dir || path.startsWith('__MACOSX/')) {
      return;
    }
    const base = path.split('/').pop();
    if (!base || base.startsWith('.')) {
      return;
    }
    if (IMAGE_EXTENSIONS.test(base)) {
      entries.push({ base, entry });
    }
  });

  if (!entries.length) {
    updateStatus(`No images found in ${file.name}.`);
    return;
  }

  // Natural-sort by filename so the gallery order is sensible (1,2,…,10 not 1,10,2).
  entries.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true, sensitivity: 'base' }));

  // Extract one at a time (not all at once) to keep the peak memory down.
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const { base, entry } = entries[i];
    try {
      const blob = await entry.async('blob');
      files.push(new File([blob], base, { type: mimeFromName(base), lastModified: entryDate(entry) }));
    } catch (error) {
      /* skip a single unreadable entry, keep going */
    }
    if (i % 10 === 0 || i === entries.length - 1) {
      updateStatus(`Unzipping ${file.name}: ${i + 1} / ${entries.length}…`);
    }
  }

  archive = null; // release the compressed data

  if (!files.length) {
    updateStatus(`Couldn't extract any images from ${file.name}.`);
    return;
  }

  // Reuse the normal add path (dedup + persist + gallery rebuild).
  handlePickedFiles(files, null);
  updateStatus(`Added ${files.length} image${files.length === 1 ? '' : 's'} from ${file.name}. Saved to your library — ready to use offline.`);
}

function mimeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    bmp: 'image/bmp',
  };
  return map[ext] || '';
}

function entryDate(entry) {
  const time = entry?.date instanceof Date ? entry.date.getTime() : Date.now();
  return Number.isFinite(time) ? time : Date.now();
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
    // A dropped .zip is unpacked; everything else is added directly.
    const zips = files.filter(isZipFile);
    const rest = files.filter((file) => !isZipFile(file));
    if (rest.length) {
      handlePickedFiles(rest, null);
    }
    for (const zip of zips) {
      await importZip(zip);
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
  sortImagesByCaptureDate();
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
  sortImagesByCaptureDate();
  galleryDirty = true;
  updateEnterVRButton();
  updateLibraryControls();
}

// Stable identity for a picked File so the same image isn't added twice.
function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// Sort key for gallery/stepping order: the photo's capture time. Uses an
// already-read embedded date (EXIF/XMP) when we have one cached, else the date
// in the filename (camera names like IMG_20170610_160948), else the file's own
// timestamp as a last resort.
function captureSortKey(file) {
  const cached = infoCache.get(fileKey(file));
  if (cached instanceof Date) {
    return cached.getTime();
  }
  const nameDate = parseFilenameDate(file.name);
  if (nameDate) {
    return nameDate.getTime();
  }
  return file.lastModified || 0;
}

// Order images oldest -> newest so the gallery (which lists from the end up)
// shows the NEWEST at the top, and trigger-stepping runs older <-> newer.
function sortImagesByCaptureDate() {
  imageFiles.sort((a, b) => captureSortKey(a) - captureSortKey(b));
}

// Build a stereo pair of thumbnail textures (top half -> left eye, bottom half
// -> right eye) so each card previews in 3D, matching the main viewer.
// Decodes the image DOWNSCALED (~1024px wide) so a big library doesn't exhaust
// memory — thumbnails don't need full resolution.
async function createThumbnailEyes(file) {
  // Flat panos (-2D/-SPHERE) have no second eye, so both card-eyes show the
  // whole image; stereo files keep the top/bottom split.
  const eyeHalves = detectPanoMode(file.name) === 'stereo' ? ['top', 'bottom'] : ['full', 'full'];

  // Preferred path: decode straight to a small bitmap (low memory).
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { resizeWidth: 1920, resizeQuality: 'medium' });
      const eyes = {
        left: halfTexture(bitmap, bitmap.width, bitmap.height, eyeHalves[0]),
        right: halfTexture(bitmap, bitmap.width, bitmap.height, eyeHalves[1]),
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
      left: halfTexture(image, image.naturalWidth, image.naturalHeight, eyeHalves[0]),
      right: halfTexture(image, image.naturalWidth, image.naturalHeight, eyeHalves[1]),
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

  if (which === 'full') {
    // Flat pano (-2D/-SPHERE): show the WHOLE image, letterboxed to preserve its
    // aspect ratio so the thumbnail isn't stretched.
    ctx.fillStyle = '#0c131c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / width, canvas.height / height);
    const drawW = width * scale;
    const drawH = height * scale;
    ctx.drawImage(source, 0, 0, width, height, (canvas.width - drawW) / 2, (canvas.height - drawH) / 2, drawW, drawH);
  } else {
    // Stereo: keep the centre band of this eye-half, dropping blurry top/bottom pad.
    const regionHeight = Math.floor(height / 2);
    const regionTop = which === 'bottom' ? Math.floor(height / 2) : 0;
    const keptHeight = Math.floor(regionHeight * THUMB_CROP);
    const inset = Math.floor((regionHeight - keptHeight) / 2);
    const sourceY = regionTop + inset;
    ctx.drawImage(source, 0, sourceY, width, keptHeight, 0, 0, canvas.width, canvas.height);
  }

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

    currentPanoMode = detectPanoMode(imageFile.name);
    applyPanoTextures(baseTexture);
    panoGroup.visible = true;
    loadingText.visible = false;
    playMatchingAudio(imageFile.name);
    // Clean, control-free view while looking at the panorama.
    setPointerVisibility(false);
    // Read this image's capture date (for the A/X info panel) in the background.
    updateCurrentImageInfo(imageFile);
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
