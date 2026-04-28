import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/VRButton.js';
import { XRHandModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

let scene;
let camera;
let renderer;
let panoMesh;
let sphereMesh;
let material;
let backButton;
let backTimer = null;

let controllers = [];
let hands = [];
let interactiveObjects = [];
let loadedFiles = [];

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const folderInput = document.getElementById('folderInput');
const loadingText = document.getElementById('loading');
const fileCount = document.getElementById('fileCount');
const enterVrButton = document.getElementById('enterVrButton');
const uiCard = document.getElementById('ui');

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('xr-canvas'),
    antialias: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  createPanoMesh();
  createSphereMesh();
  createBackButton();

  setupControllers();
  setupHands();
  setupFolderInput();
  setupEnterVrButton();

  window.addEventListener('resize', onWindowResize);
}

function setupEnterVrButton() {
  const vrButton = VRButton.createButton(renderer, {
    optionalFeatures: ['hand-tracking']
  });

  vrButton.id = 'nativeVrButton';
  vrButton.classList.add('native-vr-button');
  vrButton.style.display = 'none';
  document.body.appendChild(vrButton);

  enterVrButton.addEventListener('click', () => {
    if (!loadedFiles.length) {
      return;
    }

    createGallery(loadedFiles);
    vrButton.click();
  });

  renderer.xr.addEventListener('sessionstart', () => {
    uiCard.classList.add('hidden');
  });

  renderer.xr.addEventListener('sessionend', () => {
    uiCard.classList.remove('hidden');
  });
}

function setupFolderInput() {
  folderInput.addEventListener('change', async (event) => {
    loadingText.style.display = 'block';

    const allFiles = Array.from(event.target.files || []);
    loadedFiles = allFiles.filter(isImageFile);

    const count = loadedFiles.length;
    fileCount.textContent = `${count} image file${count === 1 ? '' : 's'} loaded`;

    enterVrButton.disabled = count === 0;
    enterVrButton.style.display = count > 0 ? 'inline-flex' : 'none';

    loadingText.style.display = 'none';
  });
}

function isImageFile(file) {
  if (file.type && file.type.startsWith('image/')) {
    return true;
  }

  const lowerName = file.name.toLowerCase();
  return [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp',
    '.avif',
    '.heic',
    '.heif'
  ].some((ext) => lowerName.endsWith(ext));
}

function createPanoMesh() {
  const geometry = new THREE.CylinderGeometry(5, 5, 3, 128, 64, true, -Math.PI / 2, Math.PI);

  material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      depthMap: { value: null },
      depthScale: { value: 0.4 }
    },
    vertexShader: `
      varying vec2 vUv;
      uniform sampler2D depthMap;
      uniform float depthScale;

      void main() {
        vUv = uv;
        float depth = texture2D(depthMap, uv).r;
        depth = smoothstep(0.2, 0.8, depth);
        vec3 displaced = position + normal * depth * depthScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D map;

      void main() {
        gl_FragColor = texture2D(map, vUv);
      }
    `
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

function createBackButton() {
  const geometry = new THREE.PlaneGeometry(0.6, 0.25);
  const material = new THREE.MeshBasicMaterial({ color: 0x222222 });

  backButton = new THREE.Mesh(geometry, material);
  backButton.position.set(0, 1.2, -1);
  backButton.visible = false;
  backButton.userData.onClick = showGallery;

  scene.add(backButton);
  interactiveObjects.push(backButton);
}

function showBackButton() {
  backButton.visible = true;
  if (backTimer) {
    clearTimeout(backTimer);
  }
  backTimer = setTimeout(() => {
    backButton.visible = false;
  }, 4000);
}

function showGallery() {
  panoMesh.visible = false;
  sphereMesh.visible = false;
  backButton.visible = false;
}

function setupControllers() {
  for (let i = 0; i < 2; i += 1) {
    const controller = renderer.xr.getController(i);

    controller.addEventListener('selectstart', () => {
      showBackButton();
      controller.userData.selectPressed = true;
    });

    controller.addEventListener('selectend', () => {
      controller.userData.selectPressed = false;
    });

    scene.add(controller);
    controllers.push(controller);
  }
}

function setupHands() {
  const factory = new XRHandModelFactory();

  for (let i = 0; i < 2; i += 1) {
    const hand = renderer.xr.getHand(i);
    const model = factory.createHandModel(hand, 'mesh');

    hand.add(model);
    scene.add(hand);
    hands.push(hand);
  }
}

function createGallery(files) {
  clearGallery();

  const radius = 2.5;

  files.forEach(async (file, index) => {
    const angle = (-Math.PI / 2) + (index * (Math.PI / files.length));
    const texture = await createThumbnail(file);

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.4),
      new THREE.MeshBasicMaterial({ map: texture })
    );

    mesh.position.set(Math.sin(angle) * radius, 1.5, Math.cos(angle) * radius);
    mesh.lookAt(0, 1.5, 0);

    mesh.userData.onClick = () => {
      loadImage(file);
    };

    scene.add(mesh);
    interactiveObjects.push(mesh);
  });
}

function clearGallery() {
  interactiveObjects.forEach((obj) => {
    if (obj !== backButton) {
      scene.remove(obj);
    }
  });
  interactiveObjects = [backButton];
}

async function createThumbnail(file) {
  const image = new Image();
  image.src = URL.createObjectURL(file);
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  const texture = new THREE.Texture(canvas);
  texture.needsUpdate = true;
  URL.revokeObjectURL(image.src);
  return texture;
}

async function loadImage(file) {
  const image = new Image();
  image.src = URL.createObjectURL(file);
  await image.decode();

  const texture = new THREE.Texture(image);
  texture.needsUpdate = true;

  const ratio = image.width / image.height;

  if (ratio > 1.9 && ratio < 2.1) {
    sphereMesh.visible = true;
    panoMesh.visible = false;
    sphereMesh.material.map = texture;
  } else {
    panoMesh.visible = true;
    sphereMesh.visible = false;
    material.uniforms.map.value = texture;
    material.uniforms.depthMap.value = texture;
  }

  URL.revokeObjectURL(image.src);
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

  interactiveObjects.forEach((obj) => {
    obj.scale.set(1, 1, 1);
  });

  if (!hits.length) {
    return;
  }

  const selected = hits[0].object;
  selected.scale.set(1.1, 1.1, 1.1);

  if (controller.userData.selectPressed) {
    controller.userData.selectPressed = false;
    if (selected.userData.onClick) {
      selected.userData.onClick();
    }
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
