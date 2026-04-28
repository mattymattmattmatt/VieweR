import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/VRButton.js';
import { XRHandModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

let scene, camera, renderer;
let panoMesh, material;
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
      depthScale: { value: 0.4 },
      opacity: { value: 1.0 }
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
      uniform float opacity;

      void main() {
        vec4 color = texture2D(map, vUv);
        gl_FragColor = vec4(color.rgb, opacity);
      }
    `
  });

  panoMesh = new THREE.Mesh(geometry, material);
  panoMesh.scale.x = -1;
  scene.add(panoMesh);
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
  const indexTip = hand.joints['index-finger-tip'];
  const thumbTip = hand.joints['thumb-tip'];

  if (!indexTip || !thumbTip) return false;

  return indexTip.position.distanceTo(thumbTip.position) < 0.025;
}

function handleHand(hand) {
  const isPinching = detectPinch(hand);
  const now = performance.now();

  const indexTip = hand.joints['index-finger-tip'];
  if (!indexTip) return;

  raycaster.ray.origin.copy(indexTip.position);

  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(indexTip.quaternion);
  raycaster.ray.direction.copy(dir);

  const hits = raycaster.intersectObjects(interactiveObjects);

  interactiveObjects.forEach(o => o.scale.set(1,1,1));

  if (hits.length > 0) {
    const obj = hits[0].object;
    obj.scale.set(1.2,1.2,1.2);

    if (isPinching && !hand.userData.isPinching && now - hand.userData.lastPinchTime > 400) {
      hand.userData.lastPinchTime = now;
      obj.userData.onClick();
    }
  }

  hand.userData.isPinching = isPinching;
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
    const files = Array.from(e.target.files).filter(f=>f.name.endsWith(".vr.jpg"));
    createGallery(files);
  });
}

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

    mesh.userData.onClick=()=>loadVR(file);

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

async function extractData(file){
  const txt=await file.text();
  const xmp=txt.substring(txt.indexOf("<x:xmpmeta"),txt.indexOf("</x:xmpmeta>"));

  return {
    depth: xmp.match(/GDepth:Data="([^"]+)"/)[1],
    image: xmp.match(/GImage:Data="([^"]+)"/)[1]
  };
}

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

async function loadVR(file){
  document.getElementById("loading").style.display="block";

  const d=await extractData(file);

  const color=await b64ToTex(d.image,"image/jpeg");
  const depth=await b64ToTex(d.depth,"image/png");

  material.uniforms.map.value=color;
  material.uniforms.depthMap.value=depth;

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