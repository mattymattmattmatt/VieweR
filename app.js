import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/VRButton.js';
import { XRHandModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

let scene, camera, renderer;
let panoMesh, sphereMesh, material;

let controllers = [];
let hands = [];
let interactiveObjects = [];

let raycaster = new THREE.Raycaster();
let tempMatrix = new THREE.Matrix4();

init();
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("xr-canvas"),
    antialias: true
  });

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  document.body.appendChild(VRButton.createButton(renderer, {
    optionalFeatures: ['hand-tracking']
  }));

  createPanoMesh();
  createSphereMesh();
  setupControllers();
  setupHands();
  setupFolderInput();
}

---

function createPanoMesh() {
  const geometry = new THREE.CylinderGeometry(5,5,3,128,64,true,-Math.PI/2,Math.PI);

  material = new THREE.ShaderMaterial({
    transparent: true,
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
        depth = smoothstep(0.2,0.8,depth);
        vec3 displaced = position + normal * depth * depthScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced,1.0);
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
  scene.add(panoMesh);
}

---

function createSphereMesh() {
  const geometry = new THREE.SphereGeometry(50, 64, 64);
  geometry.scale(-1, 1, 1);

  const mat = new THREE.MeshBasicMaterial({ map: null });

  sphereMesh = new THREE.Mesh(geometry, mat);
  sphereMesh.visible = false;

  scene.add(sphereMesh);
}

---

function setupControllers() {
  for (let i=0;i<2;i++){
    const c = renderer.xr.getController(i);
    c.userData.selectPressed = false;

    c.addEventListener('selectstart',()=>c.userData.selectPressed=true);
    c.addEventListener('selectend',()=>c.userData.selectPressed=false);

    scene.add(c);
    controllers.push(c);
  }
}

---

function setupHands() {
  const factory = new XRHandModelFactory();

  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);

    hand.userData.isPinching = false;
    hand.userData.lastPinchTime = 0;

    const model = factory.createHandModel(hand, 'mesh');
    hand.add(model);

    scene.add(hand);
    hands.push(hand);
  }
}

---

function detectPinch(hand) {
  const i = hand.joints['index-finger-tip'];
  const t = hand.joints['thumb-tip'];
  if (!i || !t) return false;
  return i.position.distanceTo(t.position) < 0.025;
}

function handleHand(hand) {
  const pinch = detectPinch(hand);
  const now = performance.now();

  const tip = hand.joints['index-finger-tip'];
  if (!tip) return;

  raycaster.ray.origin.copy(tip.position);
  raycaster.ray.direction.set(0,0,-1).applyQuaternion(tip.quaternion);

  const hits = raycaster.intersectObjects(interactiveObjects);

  interactiveObjects.forEach(o => o.scale.set(1,1,1));

  if (hits.length > 0) {
    const obj = hits[0].object;
    obj.scale.set(1.2,1.2,1.2);

    if (pinch && !hand.userData.isPinching && now - hand.userData.lastPinchTime > 400) {
      hand.userData.lastPinchTime = now;
      obj.userData.onClick();
    }
  }

  hand.userData.isPinching = pinch;
}

---

function handleController(c){
  tempMatrix.identity().extractRotation(c.matrixWorld);

  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix);

  const hits = raycaster.intersectObjects(interactiveObjects);

  if(hits.length>0){
    const obj = hits[0].object;
    obj.scale.set(1.2,1.2,1.2);

    if(c.userData.selectPressed){
      obj.userData.onClick();
    }
  }
}

---

function setupFolderInput(){
  const input = document.getElementById("folderInput");

  input.addEventListener("change",(e)=>{
    const files = Array.from(e.target.files)
      .filter(f => f.name.endsWith(".vr.jpg") || f.type.startsWith("image"));

    createGallery(files);
  });
}

---

function createGallery(files){
  clearGallery();

  const r=2.5;

  files.forEach(async (file,i)=>{
    const angle = (-Math.PI/2)+(i*(Math.PI/files.length));

    const tex = await createThumbnail(file);

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6,0.4),
      new THREE.MeshBasicMaterial({map:tex})
    );

    mesh.position.set(Math.sin(angle)*r,1.5,Math.cos(angle)*r);
    mesh.lookAt(0,1.5,0);

    mesh.userData.onClick = () => loadImage(file);

    scene.add(mesh);
    interactiveObjects.push(mesh);
  });
}

function clearGallery(){
  interactiveObjects.forEach(o=>scene.remove(o));
  interactiveObjects=[];
}

---

async function createThumbnail(file){
  const img=new Image();
  img.src=URL.createObjectURL(file);
  await img.decode();

  const c=document.createElement("canvas");
  c.width=256;c.height=128;

  c.getContext("2d").drawImage(img,0,0,c.width,c.height);

  const tex=new THREE.Texture(c);
  tex.needsUpdate=true;
  return tex;
}

---

async function detectFormat(file) {
  const text = await file.text();
  if (text.includes("GDepth:Data")) return "cardboard";
  return "unknown";
}

function loadImageDimensions(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);

    img.onload = () => {
      resolve({ width: img.width, height: img.height, img });
    };
  });
}

---

function b64ToTex(b64,type){
  return new Promise(res=>{
    const img=new Image();
    img.src=`data:${type};base64,${b64}`;
    img.onload=()=>{
      const t=new THREE.Texture(img);
      t.needsUpdate=true;
      res(t);
    };
  });
}

---

async function loadImage(file){
  document.getElementById("loading").style.display="block";

  const format = await detectFormat(file);

  if (format === "cardboard") {
    const txt = await file.text();
    const xmp = txt.substring(txt.indexOf("<x:xmpmeta"), txt.indexOf("</x:xmpmeta>"));

    const depth = xmp.match(/GDepth:Data="([^"]+)"/)[1];
    const image = xmp.match(/GImage:Data="([^"]+)"/)[1];

    const colorTex = await b64ToTex(image,"image/jpeg");
    const depthTex = await b64ToTex(depth,"image/png");

    panoMesh.visible = true;
    sphereMesh.visible = false;

    material.uniforms.map.value = colorTex;
    material.uniforms.depthMap.value = depthTex;

  } else {
    const { width, height, img } = await loadImageDimensions(file);

    const texture = new THREE.Texture(img);
    texture.needsUpdate = true;

    const ratio = width / height;

    if (ratio > 1.9 && ratio < 2.1) {
      sphereMesh.visible = true;
      panoMesh.visible = false;

      sphereMesh.material.map = texture;
      sphereMesh.material.needsUpdate = true;

    } else {
      panoMesh.visible = true;
      sphereMesh.visible = false;

      material.uniforms.map.value = texture;
      material.uniforms.depthMap.value = texture;
    }
  }

  document.getElementById("loading").style.display="none";
}

---

function animate(){
  renderer.setAnimationLoop(()=>{
    controllers.forEach(handleController);
    hands.forEach(handleHand);
    renderer.render(scene,camera);
  });
}