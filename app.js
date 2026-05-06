import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js';

import { VRButton }
from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/VRButton.js';

import { XRHandModelFactory }
from 'https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js';

////////////////////////////////////////////////////

let scene;
let camera;
let renderer;

let sphereMesh;

let controllers = [];
let hands = [];

let interactiveObjects = [];

let loadedFiles = [];

let currentAudio = null;

let audioEnabled = true;

let raycaster = new THREE.Raycaster();
let tempMatrix = new THREE.Matrix4();

let backButton;
let muteButton;

let backTimer = null;

////////////////////////////////////////////////////

init();
animate();

////////////////////////////////////////////////////

function init(){

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  camera.position.set(0,1.6,0);

  renderer = new THREE.WebGLRenderer({
    canvas:document.getElementById("xr-canvas"),
    antialias:true
  });

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );

  renderer.xr.enabled = true;

  createEnterVRButton();

  createStereoSphere();

  createBackButton();

  createMuteButton();

  setupControllers();

  setupHands();

  setupFolderInput();

  window.addEventListener(
    'resize',
    onWindowResize
  );
}

////////////////////////////////////////////////////

function createEnterVRButton(){

  const btn = document.createElement("button");

  btn.innerText = "Enter VR Gallery";

  btn.style.position = "absolute";

  btn.style.bottom = "30px";

  btn.style.left = "50%";

  btn.style.transform =
    "translateX(-50%)";

  btn.style.fontSize = "18px";

  btn.style.padding = "14px 24px";

  btn.style.zIndex = "999";

  btn.style.display = "none";

  document.body.appendChild(btn);

  btn.onclick = async ()=>{

    const vrBtn =
      VRButton.createButton(
        renderer,
        {
          optionalFeatures:[
            'hand-tracking'
          ]
        }
      );

    document.body.appendChild(vrBtn);

    vrBtn.click();

    btn.style.display = "none";

    document.getElementById("ui")
      .style.display = "none";

    createGallery(loadedFiles);
  };

  window.enterVRButton = btn;
}

////////////////////////////////////////////////////

function createStereoSphere(){

  const geometry =
    new THREE.SphereGeometry(
      50,
      64,
      64
    );

  geometry.scale(-1,1,1);

  const material =
    new THREE.ShaderMaterial({

      uniforms:{
        pano:{value:null}
      },

      vertexShader:`

        varying vec2 vUv;

        void main(){

          vUv = uv;

          gl_Position =
            projectionMatrix *
            modelViewMatrix *
            vec4(position,1.0);
        }
      `,

      fragmentShader:`

        uniform sampler2D pano;

        varying vec2 vUv;

        void main(){

          vec2 uv = vUv;

          #ifdef VIEW_LEFT
            uv.y = uv.y * 0.5;
          #else
            uv.y = 0.5 + (uv.y * 0.5);
          #endif

          gl_FragColor =
            texture2D(pano,uv);
        }
      `
    });

  sphereMesh =
    new THREE.Mesh(
      geometry,
      material
    );

  sphereMesh.visible = false;

  scene.add(sphereMesh);
}

////////////////////////////////////////////////////

function createBackButton(){

  const geo =
    new THREE.PlaneGeometry(
      0.5,
      0.2
    );

  const mat =
    new THREE.MeshBasicMaterial({
      color:0x222222
    });

  backButton =
    new THREE.Mesh(geo,mat);

  backButton.position.set(
    0,
    1.2,
    -1
  );

  backButton.visible = false;

  backButton.userData.onClick =
    showGallery;

  scene.add(backButton);

  interactiveObjects.push(backButton);
}

////////////////////////////////////////////////////

function createMuteButton(){

  const geo =
    new THREE.PlaneGeometry(
      0.5,
      0.2
    );

  const mat =
    new THREE.MeshBasicMaterial({
      color:0x444444
    });

  muteButton =
    new THREE.Mesh(geo,mat);

  muteButton.position.set(
    0.7,
    1.2,
    -1
  );

  muteButton.visible = false;

  muteButton.userData.onClick =
    toggleMute;

  scene.add(muteButton);

  interactiveObjects.push(muteButton);
}

////////////////////////////////////////////////////

function toggleMute(){

  audioEnabled =
    !audioEnabled;

  if(currentAudio){

    currentAudio.muted =
      !audioEnabled;
  }
}

////////////////////////////////////////////////////

function showBackButton(){

  backButton.visible = true;

  muteButton.visible = true;

  if(backTimer){

    clearTimeout(backTimer);
  }

  backTimer =
    setTimeout(()=>{

      backButton.visible = false;

      muteButton.visible = false;

    },4000);
}

////////////////////////////////////////////////////

function showGallery(){

  sphereMesh.visible = false;

  backButton.visible = false;

  muteButton.visible = false;

  if(currentAudio){

    currentAudio.pause();

    currentAudio = null;
  }
}

////////////////////////////////////////////////////

function setupControllers(){

  for(let i=0;i<2;i++){

    const c =
      renderer.xr.getController(i);

    c.userData.selectPressed =
      false;

    c.addEventListener(
      'selectstart',
      ()=>{

        showBackButton();

        c.userData.selectPressed =
          true;
      }
    );

    c.addEventListener(
      'selectend',
      ()=>{

        c.userData.selectPressed =
          false;
      }
    );

    scene.add(c);

    controllers.push(c);
  }
}

////////////////////////////////////////////////////

function setupHands(){

  const factory =
    new XRHandModelFactory();

  for(let i=0;i<2;i++){

    const hand =
      renderer.xr.getHand(i);

    const model =
      factory.createHandModel(
        hand,
        'mesh'
      );

    hand.add(model);

    hand.userData.isPinching =
      false;

    scene.add(hand);

    hands.push(hand);
  }
}

////////////////////////////////////////////////////

function detectPinch(hand){

  const i =
    hand.joints[
      'index-finger-tip'
    ];

  const t =
    hand.joints[
      'thumb-tip'
    ];

  if(!i || !t) return false;

  return (
    i.position.distanceTo(
      t.position
    ) < 0.025
  );
}

////////////////////////////////////////////////////

function handleHand(hand){

  const pinch =
    detectPinch(hand);

  const tip =
    hand.joints[
      'index-finger-tip'
    ];

  if(!tip) return;

  raycaster.ray.origin.copy(
    tip.position
  );

  raycaster.ray.direction
    .set(0,0,-1)
    .applyQuaternion(
      tip.quaternion
    );

  const hits =
    raycaster.intersectObjects(
      interactiveObjects
    );

  interactiveObjects.forEach(o=>{

    o.scale.set(1,1,1);
  });

  if(hits.length > 0){

    const obj =
      hits[0].object;

    obj.scale.set(
      1.2,
      1.2,
      1.2
    );

    if(
      pinch &&
      !hand.userData.isPinching
    ){

      showBackButton();

      obj.userData.onClick();
    }
  }

  hand.userData.isPinching =
    pinch;
}

////////////////////////////////////////////////////

function handleController(c){

  tempMatrix.identity()
    .extractRotation(
      c.matrixWorld
    );

  raycaster.ray.origin
    .setFromMatrixPosition(
      c.matrixWorld
    );

  raycaster.ray.direction
    .set(0,0,-1)
    .applyMatrix4(tempMatrix);

  const hits =
    raycaster.intersectObjects(
      interactiveObjects
    );

  interactiveObjects.forEach(o=>{

    o.scale.set(1,1,1);
  });

  if(hits.length > 0){

    const obj =
      hits[0].object;

    obj.scale.set(
      1.2,
      1.2,
      1.2
    );

    if(c.userData.selectPressed){

      obj.userData.onClick();
    }
  }
}

////////////////////////////////////////////////////

function setupFolderInput(){

  document
    .getElementById(
      "folderInput"
    )
    .addEventListener(
      "change",
      (e)=>{

        loadedFiles =
          Array.from(
            e.target.files
          );

        if(
          loadedFiles.length > 0
        ){

          window.enterVRButton
            .style.display =
              "block";
        }
      }
    );
}

////////////////////////////////////////////////////

function createGallery(files){

  clearGallery();

  const imageFiles =
    files.filter(f=>

      f.type.startsWith(
        "image"
      )
    );

  const r = 2.5;

  imageFiles.forEach(
    async(file,i)=>{

      const angle =
        (-Math.PI/2)
        +
        (
          i *
          (
            Math.PI /
            imageFiles.length
          )
        );

      const tex =
        await createThumbnail(file);

      const mesh =
        new THREE.Mesh(

          new THREE.PlaneGeometry(
            0.6,
            0.4
          ),

          new THREE.MeshBasicMaterial({
            map:tex
          })
        );

      mesh.position.set(
        Math.sin(angle)*r,
        1.5,
        Math.cos(angle)*r
      );

      mesh.lookAt(
        0,
        1.5,
        0
      );

      mesh.userData.onClick =
        ()=>loadStereoImage(file);

      scene.add(mesh);

      interactiveObjects.push(mesh);
    }
  );
}

////////////////////////////////////////////////////

function clearGallery(){

  interactiveObjects.forEach(o=>{

    if(
      o !== backButton &&
      o !== muteButton
    ){

      scene.remove(o);
    }
  });

  interactiveObjects = [
    backButton,
    muteButton
  ];
}

////////////////////////////////////////////////////

async function createThumbnail(file){

  const img =
    new Image();

  img.src =
    URL.createObjectURL(file);

  await img.decode();

  const c =
    document.createElement(
      "canvas"
    );

  c.width = 256;

  c.height = 128;

  c.getContext("2d")
    .drawImage(
      img,
      0,
      0,
      c.width,
      c.height
    );

  const tex =
    new THREE.Texture(c);

  tex.needsUpdate = true;

  return tex;
}

////////////////////////////////////////////////////

async function loadStereoImage(
  imageFile
){

  const img =
    new Image();

  img.src =
    URL.createObjectURL(
      imageFile
    );

  await img.decode();

  const texture =
    new THREE.Texture(img);

  texture.needsUpdate = true;

  sphereMesh.material
    .uniforms
    .pano
    .value = texture;

  sphereMesh.visible = true;

  playMatchingAudio(
    imageFile.name
  );
}

////////////////////////////////////////////////////

function playMatchingAudio(
  imageName
){

  const base =
    imageName.substring(
      0,
      imageName.lastIndexOf('.')
    );

  const audioFile =
    loadedFiles.find(f=>

      f.name.startsWith(base)

      &&

      f.type.includes("video")
    );

  if(!audioFile) return;

  if(currentAudio){

    currentAudio.pause();
  }

  currentAudio =
    document.createElement(
      "audio"
    );

  currentAudio.src =
    URL.createObjectURL(
      audioFile
    );

  currentAudio.loop = true;

  currentAudio.muted =
    !audioEnabled;

  currentAudio.play();
}

////////////////////////////////////////////////////

function animate(){

  renderer.setAnimationLoop(()=>{

    controllers.forEach(
      handleController
    );

    hands.forEach(
      handleHand
    );

    renderer.render(
      scene,
      camera
    );
  });
}

////////////////////////////////////////////////////

function onWindowResize(){

  camera.aspect =
    window.innerWidth /
    window.innerHeight;

  camera.updateProjectionMatrix();

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );
}