import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/VRButton.js';
import { XRHandModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

let scene, camera, renderer;
let panoMesh, sphereMesh, material;

let controllers = [], hands = [], interactiveObjects = [];
let raycaster = new THREE.Raycaster();
let tempMatrix = new THREE.Matrix4();

let backButton, backTimer = null;

let loadedFiles = []; // IMPORTANT

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

  createPanoMesh();
  createSphereMesh();
  createBackButton();

  setupControllers();
  setupHands();
  setupFolderInput();

  createEnterVRButton();
}

---

function createEnterVRButton() {
  const btn = document.createElement("button");
  btn.innerText = "Enter VR Gallery";
  btn.style.position = "absolute";
  btn.style.bottom = "20px";
  btn.style.left = "50%";
  btn.style.transform = "translateX(-50%)";
  btn.style.padding = "12px 20px";
  btn.style.fontSize = "16px";
  btn.style.display = "none";
  btn.style.zIndex = "999";

  document.body.appendChild(btn);

  btn.onclick = async () => {
    const vrBtn = VRButton.createButton(renderer, {
      optionalFeatures: ['hand-tracking']
    });

    document.body.appendChild(vrBtn);
    vrBtn.click(); // auto enter VR

    btn.style.display = "none";

    // build gallery once in VR
    createGallery(loadedFiles);
  };
}

---

function setupFolderInput(){
  document.getElementById("folderInput").addEventListener("change",(e)=>{
    loadedFiles = Array.from(e.target.files)
      .filter(f => f.name.endsWith(".vr.jpg") || f.type.startsWith("image"));

    if (loadedFiles.length > 0) {
      document.querySelector("button").style.display = "block";
    }
  });
}

---

function createPanoMesh() {
  const geometry = new THREE.CylinderGeometry(5,5,3,128,64,true,-Math.PI/2,Math.PI);

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
  const geo = new THREE.SphereGeometry(50,64,64);
  geo.scale(-1,1,1);

  sphereMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  sphereMesh.visible = false;

  scene.add(sphereMesh);
}

---

function createBackButton() {
  const geo = new THREE.PlaneGeometry(0.6,0.25);
  const mat = new THREE.MeshBasicMaterial({color:0x222222});

  backButton = new THREE.Mesh(geo,mat);
  backButton.position.set(0,1.2,-1);
  backButton.visible=false;

  backButton.userData.onClick = showGallery;

  scene.add(backButton);
  interactiveObjects.push(backButton);
}

function showBackButton(){
  backButton.visible=true;
  if(backTimer) clearTimeout(backTimer);
  backTimer=setTimeout(()=>backButton.visible=false,4000);
}

function showGallery(){
  panoMesh.visible=false;
  sphereMesh.visible=false;
  backButton.visible=false;
}

---

function setupControllers(){
  for(let i=0;i<2;i++){
    const c=renderer.xr.getController(i);

    c.addEventListener('selectstart',()=>{
      showBackButton();
      c.userData.selectPressed=true;
    });

    c.addEventListener('selectend',()=>c.userData.selectPressed=false);

    scene.add(c);
    controllers.push(c);
  }
}

---

function setupHands(){
  const factory=new XRHandModelFactory();

  for(let i=0;i<2;i++){
    const hand=renderer.xr.getHand(i);

    hand.userData.isPinching=false;

    const model=factory.createHandModel(hand,'mesh');
    hand.add(model);

    scene.add(hand);
    hands.push(hand);
  }
}

---

function createGallery(files){
  clearGallery();

  const r=2.5;

  files.forEach(async(file,i)=>{
    const angle=(-Math.PI/2)+(i*(Math.PI/files.length));

    const tex=await createThumbnail(file);

    const mesh=new THREE.Mesh(
      new THREE.PlaneGeometry(0.6,0.4),
      new THREE.MeshBasicMaterial({map:tex})
    );

    mesh.position.set(Math.sin(angle)*r,1.5,Math.cos(angle)*r);
    mesh.lookAt(0,1.5,0);

    mesh.userData.onClick=()=>loadImage(file);

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

async function loadImage(file){
  const img=new Image();
  img.src=URL.createObjectURL(file);
  await img.decode();

  const texture=new THREE.Texture(img);
  texture.needsUpdate=true;

  const ratio=img.width/img.height;

  if(ratio>1.9 && ratio<2.1){
    sphereMesh.visible=true;
    panoMesh.visible=false;
    sphereMesh.material.map=texture;
  }else{
    panoMesh.visible=true;
    sphereMesh.visible=false;
    material.uniforms.map.value=texture;
    material.uniforms.depthMap.value=texture;
  }
}

---

function animate(){
  renderer.setAnimationLoop(()=>{
    controllers.forEach(handleController);
    renderer.render(scene,camera);
  });
}

function handleController(c){
  tempMatrix.identity().extractRotation(c.matrixWorld);

  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix);

  const hits=raycaster.intersectObjects(interactiveObjects);

  if(hits.length>0){
    const obj=hits[0].object;
    obj.scale.set(1.2,1.2,1.2);

    if(c.userData.selectPressed){
      obj.userData.onClick();
    }
  }
}