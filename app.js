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

let controllers = [];
let hands = [];
let interactiveObjects = [];
let loadedFiles = [];
let galleryVisible = true;

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

  window.addEventListener('resize', onWindowResize);
}

function setupEnterVrButton() {
  const vrButton = VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] });
  vrButton.id = 'nativeVrButton';
  vrButton.classList.add('native-vr-button');
  vrButton.style.display = 'none';
  document.body.appendChild(vrButton);

  enterVrButton.addEventListener('click', () => {
    if (!loadedFiles.length) return;
    createGallery(loadedFiles);
    vrButton.click();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.add('hidden');
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

  if (!('webkitdirectory' in folderInput)) {
    folderInput.disabled = true;
    folderInput.title = 'Folder selection is not supported in this browser.';
  }
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
  sphereMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.2), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

function createUiButtonsInVr() {
  backButton = createTextButton('Back', -0.35, 1.15, -1);
  backButton.visible = false;
  backButton.userData.onClick = showGallery;

  menuButton = createTextButton('Menu', 0, 1.15, -1);
  menuButton.visible = false;
  menuButton.userData.onClick = toggleGalleryVisibility;

  exitVrButton3D = createTextButton('Exit VR', 0.35, 1.15, -1);
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
  showVrUi();
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);
    controller.addEventListener('selectstart', () => {
      showVrUi();
      controller.userData.selectPressed = true;
    });
    controller.addEventListener('selectend', () => { controller.userData.selectPressed = false; });
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
  const radius = 2.5;
  files.forEach(async (file, index) => {
    const angle = (-Math.PI / 2) + (index * (Math.PI / Math.max(files.length, 2)));
    const texture = await createThumbnail(file);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.position.set(Math.sin(angle) * radius, 1.5, Math.cos(angle) * radius);
    mesh.lookAt(0, 1.5, 0);
    mesh.userData.onClick = () => loadImage(file);
    mesh.userData.isThumb = true;
    scene.add(mesh);
    interactiveObjects.push(mesh);
  });
  showVrUi();
}

function clearGallery() {
  interactiveObjects.forEach((obj) => {
    if (obj !== backButton && obj !== menuButton && obj !== exitVrButton3D) scene.remove(obj);
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
  const texture = new THREE.Texture(image); texture.needsUpdate = true;
  const ratio = image.width / image.height;
  const isCardboard = file.name?.toLowerCase().endsWith('.vr.jpg');

  if (isCardboard || (ratio > 1.9 && ratio < 2.1)) {
    sphereMesh.visible = true;
    panoMesh.visible = false;
    sphereMesh.material.map = texture;
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

function animate() {
  renderer.setAnimationLoop(() => {
    controllers.forEach(handleController);
    renderer.render(scene, camera);
  });
}

function handleController(controller) {
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
