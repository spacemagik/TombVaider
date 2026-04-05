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
const smoothMove = new THREE.Vector3();
const moveSmoothing = 14;
const wallProbeHeight = 1.15;
const wallSkin = 0.42;

const physicsParams = {
  moveSpeed: 10,
  runMultiplier: 2,
  jumpVelocity: 11,
  gravity: -32,
  feetYOffset: 0,
  groundProbeAbove: 40,
  groundRayFarExtra: 280,
  snapEpsilon: 0.12,
  usePlaneFallback: true,
};
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
/** @type {SplatMesh | null} */
let ruinsSplat = null;
/** @type {THREE.Object3D | null} */
let levelColliderRoot = null;

/** Extra splat transform after auto-align (also used in origin preview). */
const splatFineTune = {
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rotYDeg: 0,
  uniformScale: 1,
};
let lineupPreviewActive = false;
/** @type {{ wireframeBefore: boolean } | null} */
let lineupSnapshot = null;

const viewParams = {
  /** Off by default: line up collider + splat without Laura8 in the way. */
  showCharacter: false,
};

const scaleParams = {
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  uniformScale: 1,
};
let gameGUI = null;
let baseScale = 1;
let debugCube = null;

const loadingEl = typeof document !== 'undefined' ? document.getElementById('loading') : null;
function setLoadingVisible(visible, text) {
  if (!loadingEl) return;
  if (text) loadingEl.textContent = text;
  loadingEl.classList.toggle('hidden', !visible);
  loadingEl.style.pointerEvents = visible ? 'auto' : 'none';
}

const ASSETS = {
  collider: '/simplified-mesh.glb',
  splat: '/ruins.spz',
  character: '/Animations/Laura8.glb',
};

// --- Scene Setup ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a28);
  scene.fog = new THREE.Fog(0x1a1a28, 100, 420);

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
  characterRoot.visible = viewParams.showCharacter;
  scene.add(characterRoot);

  const debugGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const debugMat = new THREE.MeshStandardMaterial({ color: 0xff6600 });
  debugCube = new THREE.Mesh(debugGeo, debugMat);
  debugCube.position.set(0, 0.8, 0);
  debugCube.name = 'debugCube';
  debugCube.visible = false;
  characterRoot.add(debugCube);

  setLoadingVisible(true, 'Loading scene…');
  loadWorldAndCharacter();

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'KeyG' && !e.repeat) toggleGameGUI();
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
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

  setupGameGUI();

  animate();
}

function setColliderWireframe(show) {
  colliderMeshes.forEach((m) => {
    if (show) {
      if (!m.userData._colliderMat) m.userData._colliderMat = m.material;
      m.material = new THREE.MeshBasicMaterial({
        color: 0x22ff66,
        wireframe: true,
        transparent: true,
        opacity: 0.45,
        depthTest: true,
        side: THREE.DoubleSide,
      });
    } else {
      const cur = m.material;
      if (cur && cur.wireframe) cur.dispose();
      m.material = m.userData._colliderMat || makeColliderMaterial();
      delete m.userData._colliderMat;
    }
  });
}

function setupGameGUI() {
  if (gameGUI) gameGUI.destroy();
  gameGUI = new GUI({ title: 'Tomb Vaider' });
  const guiState = { showCollider: false, showDebugCube: false };

  const view = gameGUI.addFolder('View');
  view.add(viewParams, 'showCharacter').name('Show character (Laura8)').onChange((v) => {
    characterRoot.visible = v;
    if (v && !character) loadCharacterModel(new GLTFLoader());
  });
  view.open();

  const move = gameGUI.addFolder('Movement');
  move.add(physicsParams, 'moveSpeed', 2, 28, 0.5);
  move.add(physicsParams, 'runMultiplier', 1, 3.5, 0.05);
  move.add(physicsParams, 'jumpVelocity', 4, 22, 0.5);
  move.add(physicsParams, 'gravity', -50, -5, 1);
  move.open();

  const ground = gameGUI.addFolder('Ground & collision');
  ground.add(physicsParams, 'feetYOffset', -1, 1.5, 0.01).name('Feet offset (Y)');
  ground.add(physicsParams, 'groundProbeAbove', 8, 120, 1).name('Ray start above feet');
  ground.add(physicsParams, 'groundRayFarExtra', 80, 600, 10).name('Ray length extra');
  ground.add(physicsParams, 'snapEpsilon', 0.02, 0.4, 0.01).name('Snap distance');
  ground.add(physicsParams, 'usePlaneFallback').name('Flat floor if no mesh hit');
  ground.add(guiState, 'showCollider').name('Show collider wireframe').onChange(setColliderWireframe);
  ground.add({ snap: () => snapCharacterToGround() }, 'snap').name('Snap feet to ground now');
  ground.open();

  const char = gameGUI.addFolder('Character scale');
  char.add(guiState, 'showDebugCube').name('Orange debug cube').onChange((v) => {
    if (debugCube) debugCube.visible = v;
  });
  char.add(scaleParams, 'uniformScale', 0.001, 100, 0.01).name('Uniform').onChange(applyScale);
  char.add(scaleParams, 'scaleX', 0.01, 10, 0.01).name('Scale X').onChange(applyScale);
  char.add(scaleParams, 'scaleY', 0.01, 10, 0.01).name('Scale Y').onChange(applyScale);
  char.add(scaleParams, 'scaleZ', 0.01, 10, 0.01).name('Scale Z').onChange(applyScale);
  char.add({ reset: () => {
    scaleParams.uniformScale = 1;
    scaleParams.scaleX = 1;
    scaleParams.scaleY = 1;
    scaleParams.scaleZ = 1;
    char.controllers.forEach((c) => c.updateDisplay?.());
    applyScale();
  } }, 'reset').name('Reset scale');

  const world = gameGUI.addFolder('Splat ↔ collider');
  world.add({
    realign: () => {
      if (ruinsSplat && levelColliderRoot) {
        alignRuinsToCollider(ruinsSplat, levelColliderRoot);
        snapCharacterToGround();
      }
    },
  }, 'realign').name('Re-align splat to mesh');

  const lineup = gameGUI.addFolder('Line-up at origin (debug)');
  lineup.add({ preview: false }, 'preview').name('Preview: mesh+spz at 0,0,0').onChange((v) => setLineupPreview(v));
  lineup.add(splatFineTune, 'offsetX', -400, 400, 0.5).name('Splat offset X').onChange(onSplatFineTuneChanged);
  lineup.add(splatFineTune, 'offsetY', -400, 400, 0.5).name('Splat offset Y').onChange(onSplatFineTuneChanged);
  lineup.add(splatFineTune, 'offsetZ', -400, 400, 0.5).name('Splat offset Z').onChange(onSplatFineTuneChanged);
  lineup.add(splatFineTune, 'rotYDeg', -180, 180, 1).name('Splat rotate Y (°)').onChange(onSplatFineTuneChanged);
  lineup.add(splatFineTune, 'uniformScale', 0.05, 8, 0.01).name('Splat scale').onChange(onSplatFineTuneChanged);
  lineup.add({
    log: () => {
      console.log(
        '[TombVaider] splatFineTune — paste into code if you want defaults:',
        JSON.stringify(splatFineTune, null, 2)
      );
    },
  }, 'log').name('Log values (console)');
  lineup.add({
    zero: () => {
      splatFineTune.offsetX = 0;
      splatFineTune.offsetY = 0;
      splatFineTune.offsetZ = 0;
      splatFineTune.rotYDeg = 0;
      splatFineTune.uniformScale = 1;
      lineup.controllers.forEach((c) => c.updateDisplay?.());
      onSplatFineTuneChanged();
    },
  }, 'zero').name('Reset splat sliders');
}

function toggleGameGUI() {
  if (!gameGUI) {
    setupGameGUI();
    return;
  }
  gameGUI.domElement.style.display = gameGUI.domElement.style.display === 'none' ? '' : 'none';
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

/** Invisible mesh: raycasts from both sides (many bake / simplified meshes are flipped). */
function makeColliderMaterial() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
    visible: false,
    side: THREE.DoubleSide,
  });
}

function alignWorldToCollider(colliderRoot) {
  worldRoot.updateMatrixWorld(true);
  tmpBox.setFromObject(colliderRoot);
  const center = tmpBox.getCenter(tmpVec);
  worldRoot.position.set(-center.x, -tmpBox.min.y, -center.z);
  worldRoot.updateMatrixWorld(true);
}

/**
 * SPZ and simplified GLB often export with different origins. Match splat AABB to collider in world space
 * so the character at scene origin sits inside both.
 */
const sparkFlipQuat = new THREE.Quaternion().set(1, 0, 0, 0);

function applySplatFineTuneToObject(ruins, basePosition) {
  ruins.scale.setScalar(splatFineTune.uniformScale);
  const qy = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(splatFineTune.rotYDeg)
  );
  ruins.quaternion.copy(sparkFlipQuat).multiply(qy);
  ruins.position.copy(basePosition);
  ruins.position.x += splatFineTune.offsetX;
  ruins.position.y += splatFineTune.offsetY;
  ruins.position.z += splatFineTune.offsetZ;
  ruins.updateMatrixWorld(true);
}

function alignRuinsToCollider(ruins, colliderRoot) {
  if (lineupPreviewActive) return;
  if (!ruins.isInitialized) return;

  ruins.position.set(0, 0, 0);
  ruins.scale.set(1, 1, 1);
  ruins.quaternion.set(1, 0, 0, 0);
  ruins.updateMatrixWorld(true);
  worldRoot.updateMatrixWorld(true);

  tmpBox.setFromObject(colliderRoot);
  const collWorld = tmpBox.clone();
  const cCenter = collWorld.getCenter(new THREE.Vector3());
  const cMinY = collWorld.min.y;

  const sb = ruins.getBoundingBox(false);
  const splWorld = sb.clone().applyMatrix4(ruins.matrixWorld);
  const sCenter = splWorld.getCenter(new THREE.Vector3());
  const sMinY = splWorld.min.y;

  const delta = new THREE.Vector3(
    cCenter.x - sCenter.x,
    cMinY - sMinY,
    cCenter.z - sCenter.z
  );
  applySplatFineTuneToObject(ruins, delta);

  const sz = collWorld.getSize(new THREE.Vector3());
  const fogFar = Math.max(480, sz.length() * 1.8);
  const fogNear = Math.min(120, fogFar * 0.12);
  scene.fog.near = fogNear;
  scene.fog.far = fogFar;

  console.log('[TombVaider] Aligned ruins.spz to collider. Level size ~', sz.x.toFixed(1), sz.y.toFixed(1), sz.z.toFixed(1));
}

function applyLineupPreviewTransforms() {
  if (!ruinsSplat) return;
  worldRoot.position.set(0, 0, 0);
  worldRoot.updateMatrixWorld(true);
  applySplatFineTuneToObject(ruinsSplat, new THREE.Vector3(0, 0, 0));
}

function setLineupPreview(on) {
  if (!ruinsSplat || !levelColliderRoot) return;
  if (on && !lineupPreviewActive) {
    lineupPreviewActive = true;
    lineupSnapshot = { wireframeBefore: colliderMeshes.some((m) => m.material?.wireframe) };
    setColliderWireframe(true);
    applyLineupPreviewTransforms();
    return;
  }
  if (!on && lineupPreviewActive) {
    lineupPreviewActive = false;
    const wf = lineupSnapshot?.wireframeBefore ?? false;
    lineupSnapshot = null;
    setColliderWireframe(wf);
    alignWorldToCollider(levelColliderRoot);
    alignRuinsToCollider(ruinsSplat, levelColliderRoot);
    snapCharacterToGround();
  }
}

function onSplatFineTuneChanged() {
  if (!ruinsSplat || !levelColliderRoot || !ruinsSplat.isInitialized) return;
  if (lineupPreviewActive) applyLineupPreviewTransforms();
  else {
    alignRuinsToCollider(ruinsSplat, levelColliderRoot);
    snapCharacterToGround();
  }
}

function snapCharacterToGround() {
  if (!collidersReady) return;
  const x = characterRoot.position.x;
  const z = characterRoot.position.z;
  characterRoot.position.y = 200;
  const gy = resolveGroundHeight(x, z, 400);
  characterRoot.position.x = x;
  characterRoot.position.z = z;
  characterRoot.position.y = (gy !== null ? gy : 0) + physicsParams.feetYOffset;
  velocity.y = 0;
  isGrounded = gy !== null;
}

function loadWorldAndCharacter() {
  const gltfLoader = new GLTFLoader();
  colliderMeshes = [];
  collidersReady = false;

  gltfLoader.load(
    ASSETS.collider,
    (gltf) => {
      const colliderRoot = gltf.scene;
      levelColliderRoot = colliderRoot;
      colliderRoot.traverse((child) => {
        if (child.isMesh) {
          const g = child.geometry;
          if (g) {
            g.computeBoundingBox();
            g.computeBoundingSphere();
          }
          child.frustumCulled = false;
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
      ruinsSplat = ruins;
      ruins.quaternion.copy(sparkFlipQuat);
      worldRoot.add(ruins);
      ruins.initialized.then(() => {
        alignRuinsToCollider(ruins, colliderRoot);
        snapCharacterToGround();
        setLoadingVisible(false);
      }).catch((err) => {
        console.error('Ruins splat failed:', err);
        setLoadingVisible(true, 'Could not load ruins.spz — add ruins (1).spz in project root');
        setTimeout(() => setLoadingVisible(false), 5000);
      });

      if (viewParams.showCharacter) loadCharacterModel(gltfLoader);
    },
    undefined,
    (err) => {
      console.error('Collider GLB failed:', err);
      if (viewParams.showCharacter) loadCharacterModel(gltfLoader);
      setLoadingVisible(false);
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
      characterRoot.visible = viewParams.showCharacter;

      applyScale();
      snapCharacterToGround();

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
    characterRoot.visible = viewParams.showCharacter;

    scaleParams.uniformScale = 1;
    scaleParams.scaleX = 1;
    scaleParams.scaleY = 1;
    scaleParams.scaleZ = 1;
    applyScale();
    snapCharacterToGround();

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
  worldRoot.updateMatrixWorld(true);
  if (!collidersReady || colliderMeshes.length === 0) return null;
  groundRaycaster.near = 0;
  rayOrigin.set(x, startY, z);
  groundRaycaster.set(rayOrigin, rayDirDown);
  groundRaycaster.far = startY + physicsParams.groundRayFarExtra;
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

  const running = keys['ShiftLeft'] || keys['ShiftRight'];
  const speed = running
    ? physicsParams.moveSpeed * physicsParams.runMultiplier
    : physicsParams.moveSpeed;
  const targetX = direction.x * speed;
  const targetZ = direction.z * speed;
  const t = 1 - Math.exp(-moveSmoothing * delta);
  if (moving) {
    smoothMove.x += (targetX - smoothMove.x) * t;
    smoothMove.z += (targetZ - smoothMove.z) * t;
  } else {
    smoothMove.x *= Math.exp(-10 * delta);
    smoothMove.z *= Math.exp(-10 * delta);
  }
  velocity.x = smoothMove.x;
  velocity.z = smoothMove.z;

  if (keys['Space'] && isGrounded) {
    velocity.y = physicsParams.jumpVelocity;
    isGrounded = false;
    playAction('jump', 0.1);
  }
  velocity.y += physicsParams.gravity * delta;

  let stepX = velocity.x * delta;
  let stepZ = velocity.z * delta;
  const stepLen = Math.hypot(stepX, stepZ);
  if (collidersReady && stepLen > 1e-4) {
    const dir = tmpVec.set(stepX / stepLen, 0, stepZ / stepLen);
    rayOrigin.set(
      characterRoot.position.x,
      characterRoot.position.y + wallProbeHeight,
      characterRoot.position.z
    );
    groundRaycaster.set(rayOrigin, dir);
    groundRaycaster.far = stepLen + wallSkin;
    const wallHits = groundRaycaster.intersectObjects(colliderMeshes, false);
    if (wallHits.length > 0) {
      const allow = Math.max(0, wallHits[0].distance - wallSkin);
      const scale = Math.min(1, allow / stepLen);
      stepX *= scale;
      stepZ *= scale;
      smoothMove.x *= scale;
      smoothMove.z *= scale;
      velocity.x = smoothMove.x;
      velocity.z = smoothMove.z;
    }
  }

  characterRoot.position.x += stepX;
  characterRoot.position.z += stepZ;
  characterRoot.position.y += velocity.y * delta;

  const probeTop = characterRoot.position.y + physicsParams.groundProbeAbove;
  let groundY = resolveGroundHeight(
    characterRoot.position.x,
    characterRoot.position.z,
    probeTop
  );
  if (groundY === null && physicsParams.usePlaneFallback) {
    groundY = 0;
  }

  if (groundY !== null) {
    const surfaceY = groundY + physicsParams.feetYOffset;
    const eps = physicsParams.snapEpsilon;
    if (velocity.y <= 0 && characterRoot.position.y <= surfaceY + eps) {
      characterRoot.position.y = surfaceY;
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
    const wantAction = moving ? (running ? 'run' : 'walk') : 'idle';
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
