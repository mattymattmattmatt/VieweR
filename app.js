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
let imageFiles = [];

let currentImageIndex = -1;

let currentAudio = null;

let audioEnabled = true;

let raycaster = new THREE.Raycaster();
let tempMatrix = new THREE.Matrix4();

let menuGroup;

let backButton;
let nextButton;
let prevButton;
let muteButton;
let exitButton;

let loadingText;

let menuTimer = null;

////////////////////////////////////////////////////

init();
animate();

////////////////////////////////////////////////////

function init(){

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth/window.innerHeight,
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

  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio,1.5)
  );

  renderer.xr.enabled = true;

  createEnterVRButton();

  createEnvironment();

  createStereoSphere();

  createMenu();

  createLoadingIndicator();

  setupControllers();

  setupHands();

  setupFolderInput();

  window.addEventListener(
    'resize',
    onWindowResize
  );
}

////////////////////////////////////////////////////

function createEnvironment(){

  const geo =
    new THREE.SphereGeometry(
      200,
      32,
      32
    );

  geo.scale(-1,1,1);

  const mat =
    new THREE.MeshBasicMaterial({
      color:0x050505
    });

  const env =
    new THREE.Mesh(geo,mat);

  scene.add(env);
}

////////////////////////////////////////////////////

function createEnterVRButton(){

  const btn =
    document.createElement("button");

  btn.innerText =
    "Enter VR Gallery";

  btn.style.position =
    "absolute";

  btn.style.bottom =
    "30px";

  btn.style.left =
    "50%";

  btn.style.transform =
    "translateX(-50%)";

  btn.style.fontSize =
    "18px";

  btn.style.padding =
    "14px 24px";

  btn.style.zIndex =
    "999";

  btn.style.display =
    "none";

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

    btn.style.display =
      "none";

    document.getElementById("ui")
      .style.display = "none";

    createGallery(imageFiles);
  };

  window.enterVRButton = btn;
}

////////////////////////////////////////////////////

function createStereoSphere(){

  const geometry =
    new THREE.SphereGeometry(
      50,
      128,
      128
    );

  geometry.scale(-1,1,1);

  const material =
    new THREE.ShaderMaterial({

      uniforms:{
        pano:{value:null},
        eyeIndex:{value:0}
      },

      transparent:true,

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
        uniform int eyeIndex;

        varying vec2 vUv;

        void main(){

          vec2 uv = vUv;

          if(eyeIndex == 0){

            uv.y =
              0.5 +
              (uv.y * 0.5);

          }else{

            uv.y =
              uv.y * 0.5;
          }

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

  sphereMesh.visible =
    false;

  sphereMesh.onBeforeRender =
    (
      renderer,
      scene,
      camera
    ) => {

      if(camera.isArrayCamera){
        return;
      }

      const eye =
        camera.viewport?.x || 0;

      sphereMesh.material
        .uniforms
        .eyeIndex
        .value =
          eye === 0 ? 0 : 1;
    };

  scene.add(sphereMesh);
}

////////////////////////////////////////////////////

function createMenu(){

  menuGroup =
    new THREE.Group();

  backButton =
    createMenuButton(
      "BACK",
      -0.6,
      0
    );

  prevButton =
    createMenuButton(
      "PREV",
      -1.2,
      0
    );

  nextButton =
    createMenuButton(
      "NEXT",
      0,
      0
    );

  muteButton =
    createMenuButton(
      "MUTE",
      0.6,
      0
    );

  exitButton =
    createMenuButton(
      "EXIT",
      -0.3,
      -0.35
    );

  backButton.userData.onClick =
    showGallery;

  nextButton.userData.onClick =
    nextImage;

  prevButton.userData.onClick =
    prevImage;

  muteButton.userData.onClick =
    toggleMute;

  exitButton.userData.onClick =
    exitVR;

  menuGroup.add(
    backButton,
    nextButton,
    prevButton,
    muteButton,
    exitButton
  );

  menuGroup.visible =
    false;

  scene.add(menuGroup);

  interactiveObjects.push(
    backButton,
    nextButton,
    prevButton,
    muteButton,
    exitButton
  );
}

////////////////////////////////////////////////////

function createMenuButton(
  text,
  x,
  y
){

  const geo =
    new THREE.PlaneGeometry(
      0.45,
      0.18
    );

  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width = 256;
  canvas.height = 128;

  const ctx =
    canvas.getContext("2d");

  ctx.fillStyle = "#222";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  ctx.fillStyle = "white";

  ctx.font =
    "bold 42px sans-serif";

  ctx.textAlign =
    "center";

  ctx.textBaseline =
    "middle";

  ctx.fillText(
    text,
    128,
    64
  );

  const tex =
    new THREE.Texture(canvas);

  tex.needsUpdate = true;

  const mat =
    new THREE.MeshBasicMaterial({
      map:tex,
      transparent:true
    });

  const mesh =
    new THREE.Mesh(
      geo,
      mat
    );

  mesh.position.set(
    x,
    y,
    0
  );

  return mesh;
}

////////////////////////////////////////////////////

function createLoadingIndicator(){

  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width = 512;
  canvas.height = 128;

  const ctx =
    canvas.getContext("2d");

  ctx.fillStyle = "white";

  ctx.font =
    "bold 48px sans-serif";

  ctx.textAlign =
    "center";

  ctx.fillText(
    "Loading...",
    256,
    64
  );

  const tex =
    new THREE.Texture(canvas);

  tex.needsUpdate = true;

  const mat =
    new THREE.MeshBasicMaterial({
      map:tex,
      transparent:true
    });

  loadingText =
    new THREE.Mesh(

      new THREE.PlaneGeometry(
        1,
        0.25
      ),

      mat
    );

  loadingText.position.set(
    0,
    1.5,
    -2
  );

  loadingText.visible =
    false;

  scene.add(loadingText);
}

////////////////////////////////////////////////////

function showMenu(){

  const dir =
    new THREE.Vector3();

  camera.getWorldDirection(dir);

  menuGroup.position.copy(
    camera.position
  ).add(
    dir.multiplyScalar(1.5)
  );

  menuGroup.lookAt(
    camera.position
  );

  menuGroup.visible = true;

  menuGroup.scale.set(
    0.85,
    0.85,
    0.85
  );

  let t = 0;

  const i =
    setInterval(()=>{

      t += 0.08;

      menuGroup.scale.lerp(
        new THREE.Vector3(1,1,1),
        t
      );

      if(t >= 1){
        clearInterval(i);
      }

    },16);

  if(menuTimer){
    clearTimeout(menuTimer);
  }

  menuTimer =
    setTimeout(()=>{
      hideMenu();
    },4000);
}

////////////////////////////////////////////////////

function hideMenu(){

  menuGroup.visible =
    false;
}

////////////////////////////////////////////////////

function toggleMute(){

  audioEnabled =
    !audioEnabled;

  if(currentAudio){

    currentAudio.muted =
      !audioEnabled;
  }

  hideMenu();
}

////////////////////////////////////////////////////

function nextImage(){

  if(
    currentImageIndex <
    imageFiles.length - 1
  ){

    currentImageIndex++;

    loadStereoImage(
      imageFiles[
        currentImageIndex
      ]
    );
  }

  hideMenu();
}

////////////////////////////////////////////////////

function prevImage(){

  if(currentImageIndex > 0){

    currentImageIndex--;

    loadStereoImage(
      imageFiles[
        currentImageIndex
      ]
    );
  }

  hideMenu();
}

////////////////////////////////////////////////////

function showGallery(){

  sphereMesh.visible =
    false;

  setPointerVisibility(true);

  hideMenu();

  if(currentAudio){

    currentAudio.pause();

    currentAudio = null;
  }
}

////////////////////////////////////////////////////

function exitVR(){

  const session =
    renderer.xr.getSession();

  if(session){
    session.end();
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

        showMenu();

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

    const geometry =
      new THREE.BufferGeometry()
        .setFromPoints([

          new THREE.Vector3(0,0,0),

          new THREE.Vector3(0,0,-1)

        ]);

    const line =
      new THREE.Line(

        geometry,

        new THREE.LineBasicMaterial({
          color:0x66ccff
        })
      );

    line.name = "pointer";

    line.scale.z = 5;

    c.add(line);

    scene.add(c);

    controllers.push(c);
  }
}

////////////////////////////////////////////////////

function setPointerVisibility(
  visible
){

  controllers.forEach(c=>{

    const pointer =
      c.getObjectByName(
        "pointer"
      );

    if(pointer){

      pointer.visible =
        visible;
    }
  });
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
      1.15,
      1.15,
      1.15
    );

    if(
      pinch &&
      !hand.userData.isPinching
    ){

      showMenu();

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
      1.15,
      1.15,
      1.15
    );

    const gp =
      c.gamepad;

    if(
      gp &&
      gp.hapticActuators &&
      gp.hapticActuators.length > 0
    ){

      gp.hapticActuators[0]
        .pulse(0.2,30);
    }

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

        imageFiles =
          loadedFiles.filter(f=>

            f.type.startsWith(
              "image"
            )
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

  const r = 2.5;

  files.forEach(
    async(file,i)=>{

      const angle =
        (-Math.PI/2)
        +
        (
          i *
          (
            Math.PI /
            files.length
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
        ()=>{

          currentImageIndex =
            imageFiles.indexOf(
              file
            );

          loadStereoImage(file);
        };

      scene.add(mesh);

      interactiveObjects.push(mesh);
    }
  );
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

  loadingText.visible =
    true;

  const img =
    new Image();

  img.src =
    URL.createObjectURL(
      imageFile
    );

  await img.decode();

  const texture =
    new THREE.Texture(img);

  texture.colorSpace =
    THREE.SRGBColorSpace;

  texture.needsUpdate =
    true;

  texture.minFilter =
    THREE.LinearFilter;

  texture.magFilter =
    THREE.LinearFilter;

  texture.generateMipmaps =
    false;

  fadeOutSphere(()=>{

    sphereMesh.material
      .uniforms
      .pano.value = texture;

    sphereMesh.visible =
      true;

    playMatchingAudio(
      imageFile.name
    );

    setPointerVisibility(
      false
    );

    fadeInSphere();

    loadingText.visible =
      false;
  });
}

////////////////////////////////////////////////////

function fadeOutSphere(cb){

  sphereMesh.material.opacity =
    1;

  const i =
    setInterval(()=>{

      sphereMesh.material.opacity
        -= 0.08;

      if(
        sphereMesh.material.opacity
        <= 0
      ){

        clearInterval(i);

        cb();
      }

    },16);
}

////////////////////////////////////////////////////

function fadeInSphere(){

  sphereMesh.material.opacity =
    0;

  const i =
    setInterval(()=>{

      sphereMesh.material.opacity
        += 0.08;

      if(
        sphereMesh.material.opacity
        >= 1
      ){

        clearInterval(i);
      }

    },16);
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

  currentAudio.loop =
    true;

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