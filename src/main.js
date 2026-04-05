import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { SplatMesh } from '@sparkjsdev/spark';
import GUI from 'lil-gui';

// --- Game State ---
const keys = {};
const pointer = { x: 0, y: 0 };
let scene, camera, renderer;
let worldRoot;
let character, characterRoot;
let mixer, actions = {}, currentAction;
let clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const moveSpeed = 8;
const runMultiplier = 1.8;
const jumpVelocity = 12;
const gravity = -30;
let isGrounded = true;
let cameraYaw = 0;
const mouseSensitivity = 0.003;

const groundRaycaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDirDown = new THREE.Vector3(0, -1, 0);
const tmpBox = new THREE.Box3();
const tmpVec = new THREE.Vector3();
/** @type {THREE.Mesh[]} */
let colliderMeshes = [];
let collidersReady = false;

const scaleParams = {
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  uniformScale: 1,
};
let scaleGUI = null;
let baseScale = 1;
let debugCube = null;

const ASSETS = {
  collider: '/simplified-mesh.glb',
  splat: '/ruins.spz',
  character: '/Animations/Laura8.glb',
};

// --- Scene Setup ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a28);
  scene.fog = new THREE.Fog(0x1a1a28, 80, 280);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 4, 10);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xfff2dc, 1.35);
  dirLight.position.set(20, 40, 15);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 120;
  dirLight.shadow.camera.left = -40;
  dirLight.shadow.camera.right = 40;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x6688cc, 0.25);
  fillLight.position.set(-15, 8, -12);
  scene.add(fillLight);

  worldRoot = new THREE.Group();
  scene.add(worldRoot);

  characterRoot = new THREE.Group();
  characterRoot.position.set(0, 0, 0);
  scene.add(characterRoot);

  const debugGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const debugMat = new THREE.MeshStandardMaterial({ color: 0xff6600 });
  debugCube = new THREE.Mesh(debugGeo, debugMat);
  debugCube.position.set(0, 0.8, 0);
  debugCube.name = 'debugCube';
  debugCube.visible = false;
  characterRoot.add(debugCube);

  loadWorldAndCharacter();

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', (e) => { keys[e.code] = true; e.preventDefault(); });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  document.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    if (document.pointerLockElement) cameraYaw -= e.movementX * mouseSensitivity;
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement) {
      keys['PointerLock'] = false;
      if (character) cameraYaw = character.rotation.y;
    }
  });

  renderer.domElement.addEventListener('click', () => {
    if (!document.pointerLockElement) {
      renderer.domElement.requestPointerLock();
      keys['PointerLock'] = true;
    }
  });

  animate();
}

function setupScaleGUI() {
  if (scaleGUI) scaleGUI.destroy();
  scaleGUI = new GUI({ title: 'Model Scale' });
  const debugState = { showHelper: false };
  scaleGUI.add(debugState, 'showHelper').name('Show debug cube').onChange((v) => {
    if (debugCube) debugCube.visible = v;
  });
  scaleGUI.add(scaleParams, 'uniformScale', 0.001, 100, 0.01).name('Scale (all axes)').onChange(applyScale);
  scaleGUI.add(scaleParams, 'scaleX', 0.01, 10, 0.01).name('Scale X').onChange(applyScale);
  scaleGUI.add(scaleParams, 'scaleY', 0.01, 10, 0.01).name('Scale Y').onChange(applyScale);
  scaleGUI.add(scaleParams, 'scaleZ', 0.01, 10, 0.01).name('Scale Z').onChange(applyScale);
  scaleGUI.add({ reset: () => {
    scaleParams.uniformScale = 1;
    scaleParams.scaleX = 1;
    scaleParams.scaleY = 1;
    scaleParams.scaleZ = 1;
    if (scaleGUI) scaleGUI.controllers.forEach((c) => c.updateDisplay?.());
    applyScale();
  } }, 'reset').name('Reset to 1');
}

function applyScale() {
  if (!character) return;
  const u = scaleParams.uniformScale * baseScale;
  character.scale.set(
    scaleParams.scaleX * u,
    scaleParams.scaleY * u,
    scaleParams.scaleZ * u
  );
}

/** Invisible mesh: raycasts only, does not draw or write depth (keeps splats visible). */
function makeColliderMaterial() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
    visible: false,
  });
}

function alignWorldToCollider(colliderRoot) {
  worldRoot.updateMatrixWorld(true);
  tmpBox.setFromObject(colliderRoot);
  const center = tmpBox.getCenter(tmpVec);
  worldRoot.position.set(-center.x, -tmpBox.min.y, -center.z);
  worldRoot.updateMatrixWorld(true);
}

function loadWorldAndCharacter() {
  const gltfLoader = new GLTFLoader();
  colliderMeshes = [];
  collidersReady = false;

  gltfLoader.load(
    ASSETS.collider,
    (gltf) => {
      const colliderRoot = gltf.scene;
      colliderRoot.traverse((child) => {
        if (child.isMesh) {
          child.material = makeColliderMaterial();
          child.castShadow = false;
          child.receiveShadow = false;
          colliderMeshes.push(child);
        }
      });

      worldRoot.add(colliderRoot);
      alignWorldToCollider(colliderRoot);
      collidersReady = colliderMeshes.length > 0;

      const ruins = new SplatMesh({ url: ASSETS.splat });
      ruins.quaternion.set(1, 0, 0, 0);
      worldRoot.add(ruins);
      ruins.initialized.then(() => {
        console.log('Ruins splat loaded');
      }).catch((err) => {
        console.error('Ruins splat failed:', err);
      });

      loadCharacterModel(gltfLoader);
    },
    undefined,
    (err) => {
      console.error('Collider GLB failed:', err);
      loadCharacterModel(gltfLoader);
    }
  );
}

function loadCharacterModel(gltfLoader) {
  gltfLoader.load(
    ASSETS.character,
    (gltf) => {
      if (character) characterRoot.remove(character);
      character = gltf.scene;
      character.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      const box = new THREE.Box3().setFromObject(character);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;

      baseScale = maxDim > 0.001 && maxDim < 1e6 ? 1.8 / maxDim : 1;
      character.position.set(-center.x, -box.min.y, -center.z);

      scaleParams.uniformScale = 1;
      scaleParams.scaleX = 1;
      scaleParams.scaleY = 1;
      scaleParams.scaleZ = 1;
      characterRoot.add(character);

      setupScaleGUI();
      applyScale();

      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(character);
        gltf.animations.forEach((clip) => {
          actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
        });
        playAction(Object.keys(actions)[0] || 'idle');
      } else {
        loadFBXCharacter();
      }
    },
    undefined,
    (err) => {
      console.warn('Laura8.glb failed, trying FBX:', err);
      loadFBXCharacter();
    }
  );
}

function loadFBXCharacter() {
  const fbxLoader = new FBXLoader();
  fbxLoader.load('/Animations/Walking%20(1).fbx', (fbx) => {
    if (character) characterRoot.remove(character);
    character = fbx;
    character.traverse((child) => {
      if (child.isMesh) child.castShadow = child.receiveShadow = true;
    });

    const box = new THREE.Box3().setFromObject(character);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    baseScale = (maxDim > 0.001 && maxDim < 1e6 ? 1.8 / maxDim : 1) * 0.01;
    character.position.y = 0;
    characterRoot.add(character);

    scaleParams.uniformScale = 1;
    scaleParams.scaleX = 1;
    scaleParams.scaleY = 1;
    scaleParams.scaleZ = 1;
    setupScaleGUI();
    applyScale();

    if (fbx.animations && fbx.animations.length > 0) {
      mixer = new THREE.AnimationMixer(character);
      fbx.animations.forEach((clip) => {
        actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
      });
      playAction(Object.keys(actions)[0]);
    }
  }, undefined, (e) => console.error('FBX load error:', e));
}

function playAction(name, fade = 0.3) {
  const want = (name || 'idle').toLowerCase();
  const key = Object.keys(actions).find((k) => {
    const n = k.toLowerCase();
    return (want === 'idle' && (n.includes('idle') || n.includes('tpose') || n.includes('stand'))) ||
           (want === 'walk' && n.includes('walk')) ||
           (want === 'run' && (n.includes('run') || n.includes('sprint'))) ||
           (want === 'jump' && n.includes('jump'));
  }) || Object.keys(actions)[0];
  const action = actions[key];
  if (!action || action === currentAction) return;
  if (currentAction) currentAction.fadeOut(fade);
  currentAction = action;
  currentAction.reset().fadeIn(fade).play();
}

function getMoveInput() {
  const forward = keys['KeyW'] ? 1 : keys['KeyS'] ? -1 : 0;
  const strafe = keys['KeyD'] ? 1 : keys['KeyA'] ? -1 : 0;
  return { forward, strafe };
}

function resolveGroundHeight(x, z, startY) {
  if (!collidersReady || colliderMeshes.length === 0) return null;
  rayOrigin.set(x, startY, z);
  groundRaycaster.set(rayOrigin, rayDirDown);
  groundRaycaster.far = startY + 200;
  const hits = groundRaycaster.intersectObjects(colliderMeshes, false);
  if (hits.length === 0) return null;
  return hits[0].point.y;
}

function updateCharacter(delta) {
  if (!characterRoot) return;

  const { forward, strafe } = getMoveInput();
  const moving = forward !== 0 || strafe !== 0;

  const cameraDir = new THREE.Vector3();
  camera.getWorldDirection(cameraDir);
  cameraDir.y = 0;
  cameraDir.normalize();
  const right = new THREE.Vector3().crossVectors(cameraDir, new THREE.Vector3(0, 1, 0));

  direction.set(0, 0, 0);
  if (forward) direction.addScaledVector(cameraDir, forward);
  if (strafe) direction.addScaledVector(right, strafe);
  if (direction.lengthSq() > 0) direction.normalize();

  const speed = keys['ShiftLeft'] ? moveSpeed * runMultiplier : moveSpeed;
  velocity.x = direction.x * speed;
  velocity.z = direction.z * speed;

  if (keys['Space'] && isGrounded) {
    velocity.y = jumpVelocity;
    isGrounded = false;
    playAction('jump', 0.1);
  }
  velocity.y += gravity * delta;

  characterRoot.position.x += velocity.x * delta;
  characterRoot.position.z += velocity.z * delta;
  characterRoot.position.y += velocity.y * delta;

  const probeTop = characterRoot.position.y + 25;
  const groundY = resolveGroundHeight(
    characterRoot.position.x,
    characterRoot.position.z,
    probeTop
  );

  if (groundY !== null) {
    const eps = 0.08;
    if (velocity.y <= 0 && characterRoot.position.y <= groundY + eps) {
      characterRoot.position.y = groundY;
      velocity.y = 0;
      isGrounded = true;
    }
  } else {
    if (characterRoot.position.y < -200) {
      characterRoot.position.set(0, 30, 0);
      velocity.set(0, 0, 0);
    }
    if (velocity.y < 0) isGrounded = false;
  }

  if (character) {
    if (moving) {
      const angle = document.pointerLockElement ? cameraYaw : Math.atan2(direction.x, direction.z);
      character.rotation.y = angle;
      if (document.pointerLockElement) cameraYaw = angle;
    } else if (document.pointerLockElement) {
      character.rotation.y = cameraYaw;
    } else {
      cameraYaw = character.rotation.y;
    }
  }

  if (mixer && Object.keys(actions).length > 0 && isGrounded) {
    const wantAction = moving ? (keys['ShiftLeft'] ? 'run' : 'walk') : 'idle';
    const curName = (currentAction?.getClip()?.name || '').toLowerCase();
    const hasWalk = curName.includes('walk');
    const hasRun = curName.includes('run');
    const hasIdle = curName.includes('idle') || curName.includes('tpose');
    const match = (wantAction === 'walk' && hasWalk) || (wantAction === 'run' && hasRun) || (wantAction === 'idle' && (hasIdle || (!hasWalk && !hasRun)));
    if (!match) playAction(wantAction, 0.2);
  }

  const targetPos = characterRoot.position.clone();
  targetPos.y += 3;
  const yaw = document.pointerLockElement ? cameraYaw : (character ? character.rotation.y : 0);
  const camOffset = new THREE.Vector3(0, 2, 8);
  camOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const camTarget = targetPos.clone().add(camOffset);

  camera.position.lerp(camTarget, 1 - Math.exp(-8 * delta));
  const lookAt = characterRoot.position.clone();
  lookAt.y += 1.5;
  camera.lookAt(lookAt);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  if (mixer) mixer.update(delta);
  updateCharacter(delta);
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

init();
