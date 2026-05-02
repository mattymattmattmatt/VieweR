import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

let scene;
let camera;
let renderer;
let panoMesh;
let sphereMesh;
let material;
let backButton;
let menuButton;
let exitVrButton3D;
let stereoSphereMaterial;

let controllers = [];
let hands = [];
let interactiveObjects = [];
let loadedFiles = [];
let galleryVisible = true;
let activeObjectUrl = null;
let vrUiVisible = false;
let galleryBuildId = 0;
let immersiveVrSupported = false;

const demoImages = [
  { name: 'Test 3D360PANO.jpg', url: 'Demo Images/Test 3D360PANO.vr.jpg' },
  { name: 'Test 360SPHERE.jpg', url: 'Demo Images/Test 360SPHERE.jpg' }
];

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const folderInput = document.getElementById('folderInput');
const fileInput = document.getElementById('fileInput');
const loadingText = document.getElementById('loading');
const fileCount = document.getElementById('fileCount');
const enterVrButton = document.getElementById('enterVrButton');
const demoPicturesButton = document.getElementById('demoPicturesButton');
const clearFilesButton = document.getElementById('clearFilesButton');
const uiCard = document.getElementById('ui');

init();
animate();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('xr-canvas'), antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  createPanoMesh();
  createSphereMesh();
  createUiButtonsInVr();

  setupControllers();
  setupHands();
  setupInputs();
  setupDemoPicturesButton();
  setupClearButton();
  setupEnterVrButton();
  detectVrSupport();

  window.addEventListener('resize', onWindowResize);
}

function setupEnterVrButton() {
  enterVrButton.addEventListener('click', () => {
    if (!loadedFiles.length) return;
    createGallery(loadedFiles);
    startVrSession();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.add('hidden');
    vrUiVisible = false;
    hideVrUi();
    showGallery();
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.classList.remove('hidden');
    hideVrUi();
  });

  exitVrButton3D.userData.onClick = () => {
    const session = renderer.xr.getSession();
    if (session) session.end();
  };
}

async function detectVrSupport() {
  if (!navigator.xr) return;
  try {
    immersiveVrSupported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    immersiveVrSupported = false;
  }
}

async function startVrSession() {
  if (!navigator.xr || !immersiveVrSupported) return;
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking'] });
    renderer.xr.setSession(session);
  } catch (error) {
    console.error('Failed to start VR session:', error);
  }
}

function setupInputs() {
  const handleInputChange = async (event) => {
    loadingText.style.display = 'block';
    const allFiles = Array.from(event.target.files || []);

    if (!allFiles.length) {
      loadingText.style.display = 'none';
      return;
    }

    const filtered = allFiles.filter(isImageFile);
    const incoming = filtered.length ? filtered : allFiles;
    mergeFiles(incoming);

    updateFileCount();
    loadingText.style.display = 'none';

    event.target.value = '';
  };

  folderInput.addEventListener('change', handleInputChange);
  folderInput.addEventListener('input', handleInputChange);
  fileInput.addEventListener('change', handleInputChange);

  // Some XR browsers support directory picking even if this property check fails.
}

function mergeFiles(files) {
  const byKey = new Map(loadedFiles.map((f) => [fileKey(f), f]));
  files.forEach((f) => byKey.set(fileKey(f), f));
  loadedFiles = Array.from(byKey.values());
}

function fileKey(file) {
  if (file.url) return `url:${file.url}`;
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function setupDemoPicturesButton() {
  demoPicturesButton.addEventListener('click', () => {
    loadedFiles = [...demoImages];
    updateFileCount(true);
  });
}

function setupClearButton() {
  clearFilesButton.addEventListener('click', () => {
    loadedFiles = [];
    clearGallery();
    showGallery();
    fileCount.textContent = '0 image files loaded';
    enterVrButton.disabled = true;
  });
}

function updateFileCount(isDemo = false) {
  const count = loadedFiles.length;
  fileCount.textContent = `${count} ${isDemo ? 'demo image' : 'image file'}${count === 1 ? '' : 's'} loaded`;
  enterVrButton.disabled = count === 0;
}

function isImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  const lowerName = file.name.toLowerCase();
  return ['.vr.jpg', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif'].some((ext) => lowerName.endsWith(ext));
}

function createPanoMesh() {
  const geometry = new THREE.CylinderGeometry(5, 5, 3, 128, 64, true, -Math.PI / 2, Math.PI);
  material = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, depthMap: { value: null }, depthScale: { value: 0.2 } },
    vertexShader: `varying vec2 vUv; uniform sampler2D depthMap; uniform float depthScale; void main(){vUv=uv; float d=texture2D(depthMap,uv).r; d=smoothstep(0.25,0.75,d); vec3 displaced=position+normal*d*depthScale; gl_Position=projectionMatrix*modelViewMatrix*vec4(displaced,1.0);}`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; void main(){gl_FragColor=texture2D(map,vUv);}`
  });
  panoMesh = new THREE.Mesh(geometry, material);
  panoMesh.scale.x = -1;
  panoMesh.visible = false;
  scene.add(panoMesh);
}

function createSphereMesh() {
  const geometry = new THREE.SphereGeometry(50, 64, 64);
  geometry.scale(-1, 1, 1);
  stereoSphereMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      eyeIndex: { value: 0 },
      stereoMode: { value: 0 }
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D map; uniform float eyeIndex; uniform float stereoMode;
    void main(){
      vec2 uv = vUv;
      if (stereoMode > 0.5) {
        uv.x = (uv.x * 0.5) + (eyeIndex > 0.5 ? 0.5 : 0.0);
      } else if (stereoMode < -0.5) {
        uv.y = (uv.y * 0.5) + (eyeIndex > 0.5 ? 0.0 : 0.5);
      }
      gl_FragColor = texture2D(map, uv);
    }`
  });
  sphereMesh = new THREE.Mesh(geometry, stereoSphereMaterial);
  sphereMesh.onBeforeRender = (renderCtx, sceneCtx, activeCamera) => {
    if (renderer.xr.isPresenting && activeCamera?.viewport) {
      stereoSphereMaterial.uniforms.eyeIndex.value = activeCamera.viewport.x === 0 ? 0 : 1;
      return;
    }
    stereoSphereMaterial.uniforms.eyeIndex.value = 0;
  };
  sphereMesh.visible = false;
  scene.add(sphereMesh);
}

function createTextButton(label, x, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1f2537'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#90a6ff'; ctx.lineWidth = 8; ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 68px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.13), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

function createUiButtonsInVr() {
  backButton = createTextButton('Back', -0.5, 1.15, -1);
  backButton.visible = false;
  backButton.userData.onClick = showGallery;

  menuButton = createTextButton('Menu', 0, 1.15, -1);
  menuButton.visible = false;
  menuButton.userData.onClick = toggleGalleryVisibility;

  exitVrButton3D = createTextButton('Exit VR', 0.5, 1.15, -1);
  exitVrButton3D.visible = false;

  [backButton, menuButton, exitVrButton3D].forEach((b) => {
    scene.add(b);
    interactiveObjects.push(b);
  });
}

function hideVrUi() { [backButton, menuButton, exitVrButton3D].forEach((b) => { b.visible = false; }); }
function showVrUi() { [backButton, menuButton, exitVrButton3D].forEach((b) => { b.visible = true; }); }

function toggleGalleryVisibility() {
  galleryVisible = !galleryVisible;
  interactiveObjects.forEach((obj) => {
    if (obj.userData.isThumb) obj.visible = galleryVisible;
  });
}

function showGallery() {
  panoMesh.visible = false;
  sphereMesh.visible = false;
  galleryVisible = true;
  interactiveObjects.forEach((obj) => {
    if (obj.userData.isThumb) obj.visible = true;
  });
  if (vrUiVisible) showVrUi();
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener('connected', (event) => {
      controller.userData.handedness = event.data?.handedness;
    });
    controller.addEventListener('selectstart', () => {
      controller.userData.selectPressed = true;
    });
    controller.addEventListener('selectend', () => { controller.userData.selectPressed = false; });
    const pointer = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -3)]),
      new THREE.LineBasicMaterial({ color: 0x8fb0ff })
    );
    controller.add(pointer);
    controller.userData.index = i;
    controller.userData.menuPressed = false;
    controller.addEventListener('squeezestart', () => {
      if (controller.userData.handedness === 'left') {
        vrUiVisible = !vrUiVisible;
        if (vrUiVisible) showVrUi(); else hideVrUi();
      }
    });
    scene.add(controller);
    controllers.push(controller);
  }
}

function setupHands() {
  const factory = new XRHandModelFactory();
  for (let i = 0; i < 2; i += 1) {
    const hand = renderer.xr.getHand(i);
    hand.add(factory.createHandModel(hand, 'mesh'));
    scene.add(hand);
    hands.push(hand);
  }
}

function createGallery(files) {
  clearGallery();
  const buildId = ++galleryBuildId;
  const radius = 2.5;
  files.forEach(async (file, index) => {
    const n = Math.max(files.length, 1);
    const phi = Math.acos(1 - (2 * (index + 0.5) / n));
    const theta = Math.PI * (1 + Math.sqrt(5)) * (index + 0.5);
    const texture = await createThumbnail(file);
    if (buildId !== galleryBuildId) {
      texture.dispose();
      return;
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.position.set(
      Math.cos(theta) * Math.sin(phi) * radius,
      1.5 + (Math.cos(phi) * radius * 0.55),
      Math.sin(theta) * Math.sin(phi) * radius
    );
    mesh.lookAt(0, 1.5, 0);
    mesh.userData.onClick = () => loadImage(file);
    mesh.userData.isThumb = true;
    scene.add(mesh);
    interactiveObjects.push(mesh);
  });
  if (vrUiVisible) showVrUi();
}

function clearGallery() {
  galleryBuildId += 1;
  interactiveObjects.forEach((obj) => {
    if (obj !== backButton && obj !== menuButton && obj !== exitVrButton3D) {
      scene.remove(obj);
      obj.material?.map?.dispose?.();
      obj.material?.dispose?.();
      obj.geometry?.dispose?.();
    }
  });
  interactiveObjects = [backButton, menuButton, exitVrButton3D];
}

async function loadImageElement(file) {
  const image = new Image();
  const source = file.url || URL.createObjectURL(file);
  image.src = source;
  await image.decode();
  return { image, source, shouldRevoke: !file.url };
}

async function createThumbnail(file) {
  const { image, source, shouldRevoke } = await loadImageElement(file);
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const texture = new THREE.Texture(canvas); texture.needsUpdate = true;
  if (shouldRevoke) URL.revokeObjectURL(source);
  return texture;
}

async function loadImage(file) {
  const { image, source, shouldRevoke } = await loadImageElement(file);
  const rightEyeImage = file.name?.toLowerCase().endsWith('.vr.jpg') ? await extractCardboardRightEye(file) : null;
  const texture = new THREE.Texture(image); texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  const ratio = image.width / image.height;
  const isCardboard = file.name?.toLowerCase().endsWith('.vr.jpg');

  if ((isCardboard && rightEyeImage) || ratio >= 3.8) {
    sphereMesh.visible = true;
    panoMesh.visible = false;
    if (isCardboard && rightEyeImage) {
      const stacked = stackStereoSideBySide(image, rightEyeImage);
      const stackedTexture = new THREE.Texture(stacked);
      stackedTexture.needsUpdate = true;
      stackedTexture.colorSpace = THREE.SRGBColorSpace;
      stereoSphereMaterial.uniforms.map.value = stackedTexture;
      stereoSphereMaterial.uniforms.stereoMode.value = 1;
    } else {
      stereoSphereMaterial.uniforms.map.value = texture;
      stereoSphereMaterial.uniforms.stereoMode.value = 1;
    }
  } else if (ratio > 1.9 && ratio < 2.1) {
    sphereMesh.visible = true;
    panoMesh.visible = false;
    stereoSphereMaterial.uniforms.map.value = texture;
    stereoSphereMaterial.uniforms.stereoMode.value = 0;
  } else {
    panoMesh.visible = true;
    sphereMesh.visible = false;
    material.uniforms.map.value = texture;
    material.uniforms.depthMap.value = texture;
  }

  galleryVisible = false;
  interactiveObjects.forEach((obj) => {
    if (obj.userData.isThumb) obj.visible = false;
  });

  if (shouldRevoke) URL.revokeObjectURL(source);
}

async function extractCardboardRightEye(file) {
  try {
    const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
    const match = text.match(/GImage:Data=\"([A-Za-z0-9+/=\s&#10;]+)\"/);
    if (!match) return null;
    const base64 = match[1].replace(/&#10;/g, '').replace(/\s/g, '');
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' });
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = URL.createObjectURL(blob);
    const right = new Image();
    right.src = activeObjectUrl;
    await right.decode();
    return right;
  } catch {
    return null;
  }
}

function stackStereoSideBySide(leftImage, rightImage) {
  const canvas = document.createElement('canvas');
  canvas.width = leftImage.width * 2;
  canvas.height = leftImage.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(leftImage, 0, 0, leftImage.width, leftImage.height);
  ctx.drawImage(rightImage, leftImage.width, 0, leftImage.width, leftImage.height);
  return canvas;
}

function animate() {
  renderer.setAnimationLoop(() => {
    controllers.forEach(handleController);
    renderer.render(scene, camera);
  });
}

function handleController(controller) {
  if (renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    const source = session?.inputSources?.[controller.userData.index];
    const pressed = Boolean(
      source?.gamepad?.buttons?.[4]?.pressed
      || source?.gamepad?.buttons?.[5]?.pressed
      || source?.gamepad?.buttons?.[1]?.pressed
    );
    if (source?.handedness === 'left' && pressed && !controller.userData.menuPressed) {
      vrUiVisible = !vrUiVisible;
      if (vrUiVisible) showVrUi(); else hideVrUi();
    }
    controller.userData.menuPressed = pressed;
  }
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(interactiveObjects, false);
  interactiveObjects.forEach((obj) => obj.scale.set(1, 1, 1));
  if (!hits.length) return;
  const selected = hits[0].object;
  selected.scale.set(1.07, 1.07, 1.07);
  if (controller.userData.selectPressed) {
    controller.userData.selectPressed = false;
    selected.userData.onClick?.();
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
