import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SplatMesh, SparkRenderer } from '@sparkjsdev/spark';
import GUI from 'lil-gui';

// --- Game State ---
const keys = {};
const pointer = { x: 0, y: 0 };
/** Trackpad / mouse: orbit camera yaw while dragging on canvas (follow mode only). */
let lookDragActive = false;
let lookDragLastX = 0;
let scene, camera, renderer;
/** @type {SparkRenderer | null} */
let sparkRenderer = null;
let orbitControls = null;
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
  /** Hold Q / E — vertical nudge (layout + escape tight spots). */
  flyVerticalSpeed: 12,
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
  /** Turn off in the panel when lining up splats without the character in frame. */
  showCharacter: true,
};

const layerParams = {
  showColliderMesh: true,
  showSplat: true,
};

/** Third-person: below ~6 the camera often sits inside huge splats → solid black / no parallax. */
const MIN_FOLLOW_DISTANCE = 8;
const MAX_FOLLOW_DISTANCE = 600;

const cameraParams = {
  followDistance: 8,
  followHeight: 2,
  /** Drag to orbit, wheel zoom — good for lining up mesh + SPZ */
  freeOrbit: false,
};

/** Trackpad-friendly: use drag-to-look + L to lock; click-to-lock fights two-finger scroll. */
const inputParams = {
  pointerLockOnClick: false,
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
const splatDiagEl = typeof document !== 'undefined' ? document.getElementById('splat-diag') : null;
let diagFrame = 0;
function setLoadingVisible(visible, text) {
  if (!loadingEl) return;
  if (text) loadingEl.textContent = text;
  if (visible) {
    loadingEl.classList.remove('hidden');
    loadingEl.style.display = 'flex';
    loadingEl.style.visibility = '';
    loadingEl.setAttribute('aria-hidden', 'false');
  } else {
    loadingEl.classList.add('hidden');
    loadingEl.style.display = 'none';
    loadingEl.style.visibility = 'hidden';
    loadingEl.setAttribute('aria-hidden', 'true');
  }
}

const ASSETS = {
  collider: '/simplified-mesh.glb',
  /** Output of: npm run build:rad -- public/ruins.spz --quality */
  splatRad: '/ruins-lod.rad',
  /** Fallback when .rad is missing: on-the-fly LoD in a worker (slower first load). */
  splatSpz: '/ruins.spz',
  character: '/Animations/Laura8.glb',
};

/** Spark 2.0: pre-built .RAD vs runtime lod; paged streaming for chunked .rad + .radc (see Spark LoD docs). */
const splatLoadParams = {
  preferRad: true,
  /** Use with `build:rad -- … --rad-chunked`; requires matching .radc chunk files. */
  pagedStreaming: false,
  /** For large coordinates: set on mesh + SparkRenderer.pagedExtSplats when using paged. */
  extSplats: false,
};

const sparkLodParams = {
  lodSplatScale: 1,
};

// --- Scene Setup ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a28);
  /** Wide defaults until align Ruins; tight fog was hiding huge splat + collider scenes. */
  scene.fog = new THREE.Fog(0x1a1a28, 80, 250000);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 250000);
  camera.position.set(0, 4, 10);

  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  sparkRenderer = new SparkRenderer({
    renderer,
    clock,
    lodSplatScale: sparkLodParams.lodSplatScale,
    pagedExtSplats: splatLoadParams.extSplats && splatLoadParams.pagedStreaming,
  });
  scene.add(sparkRenderer);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.06;
  orbitControls.minDistance = 0.5;
  orbitControls.maxDistance = 1500;
  orbitControls.enabled = false;
  orbitControls.target.set(0, 1, 0);

  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      if (cameraParams.freeOrbit) return;
      e.preventDefault();
      const dy = THREE.MathUtils.clamp(e.deltaY, -140, 140);
      const scale = (cameraParams.followDistance * 0.06 + 0.45) * 0.035;
      const step = dy * scale;
      cameraParams.followDistance = THREE.MathUtils.clamp(
        cameraParams.followDistance + step,
        MIN_FOLLOW_DISTANCE,
        MAX_FOLLOW_DISTANCE
      );
    },
    { passive: false }
  );

  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e) => {
    if (cameraParams.freeOrbit || document.pointerLockElement) return;
    if (e.button !== 0) return;
    lookDragActive = true;
    lookDragLastX = e.clientX;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!lookDragActive || document.pointerLockElement || cameraParams.freeOrbit) return;
    const dx = e.clientX - lookDragLastX;
    lookDragLastX = e.clientX;
    cameraYaw -= dx * mouseSensitivity;
  });
  const endLookDrag = () => {
    lookDragActive = false;
  };
  canvas.addEventListener('pointerup', endLookDrag);
  canvas.addEventListener('pointercancel', endLookDrag);
  canvas.addEventListener('lostpointercapture', endLookDrag);

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
    if (e.target?.closest?.('.lil-gui')) return;
    keys[e.code] = true;
    if (e.code === 'KeyG' && !e.repeat) toggleGameGUI();
    if (e.code === 'KeyL' && !e.repeat && !cameraParams.freeOrbit) {
      if (document.pointerLockElement) document.exitPointerLock();
      else canvas.requestPointerLock();
    }
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  document.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    if (document.pointerLockElement && !cameraParams.freeOrbit) {
      cameraYaw -= e.movementX * mouseSensitivity;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement) {
      keys['PointerLock'] = false;
      if (character) cameraYaw = character.rotation.y;
    }
  });

  canvas.addEventListener('click', () => {
    if (cameraParams.freeOrbit || !inputParams.pointerLockOnClick) return;
    if (!document.pointerLockElement) {
      canvas.requestPointerLock();
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
        depthWrite: false,
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
  view
    .add(inputParams, 'pointerLockOnClick')
    .name('Click canvas locks pointer (mouse)');
  view.open();

  const sceneVis = gameGUI.addFolder('Scene layers');
  sceneVis
    .add(layerParams, 'showColliderMesh')
    .name('Collider mesh (faint green + wireframe opt.)')
    .onChange((v) => {
      if (levelColliderRoot) levelColliderRoot.visible = v;
    });
  sceneVis
    .add(layerParams, 'showSplat')
    .name('SPZ splat')
    .onChange((v) => {
      if (ruinsSplat) ruinsSplat.visible = v;
    });
  sceneVis.open();

  const sparkLod = gameGUI.addFolder('Spark 2.0 LoD');
  sparkLod
    .add(sparkLodParams, 'lodSplatScale', 0.25, 4, 0.05)
    .name('lodSplatScale (detail)')
    .onChange((v) => {
      if (sparkRenderer) sparkRenderer.lodSplatScale = v;
    });
  sparkLod.add({
    help: () => {
      console.info(
        '[TombVaider] Pre-build LoD .RAD:\n  npm run build:rad -- public/ruins.spz --quality\n' +
          '→ public/ruins-lod.rad\n' +
          'Chunked HTTP streaming: build with --rad-chunked, set splatLoadParams.pagedStreaming = true in main.js.\n' +
          'Docs: https://sparkjs.dev/2.0.0-preview/docs/lod-getting-started/'
      );
    },
  }, 'help').name('Log .RAD / LoD help');
  sparkLod.open();

  const cam = gameGUI.addFolder('Camera');
  cam
    .add(cameraParams, 'followDistance', MIN_FOLLOW_DISTANCE, 400, 0.5)
    .name('Zoom (also mouse wheel)')
    .listen();
  cam.add(cameraParams, 'followHeight', 0.5, 80, 0.25).name('Height above anchor');
  cam
    .add(cameraParams, 'freeOrbit')
    .name('Free orbit (drag, wheel)')
    .onChange((v) => {
      if (!orbitControls) return;
      orbitControls.enabled = v;
      document.exitPointerLock?.();
      if (v) {
        orbitControls.target.copy(characterRoot.position).add(new THREE.Vector3(0, 1.2, 0));
        camera.position.set(
          characterRoot.position.x + 12,
          characterRoot.position.y + 8,
          characterRoot.position.z + 12
        );
        orbitControls.update();
      }
    });
  cam.open();

  const move = gameGUI.addFolder('Movement');
  move.add(physicsParams, 'moveSpeed', 2, 28, 0.5);
  move.add(physicsParams, 'runMultiplier', 1, 3.5, 0.05);
  move.add(physicsParams, 'jumpVelocity', 4, 22, 0.5);
  move.add(physicsParams, 'flyVerticalSpeed', 2, 40, 0.5).name('Q/E fly speed (Y)');
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

/**
 * Collider shell: faint + no depth write so it does not hide Spark splats behind it.
 * (Fully invisible mats looked like “no collider” when the Scene layer was on.)
 */
function makeColliderMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0x33cc66,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    depthTest: false,
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
  const fogFar = Math.max(2500, sz.length() * 2.4);
  const fogNear = Math.min(250, fogFar * 0.06);
  if (!scene.fog) {
    scene.fog = new THREE.Fog(0x1a1a28, fogNear, fogFar);
  } else {
    scene.fog.near = fogNear;
    scene.fog.far = fogFar;
  }

  console.log('[TombVaider] Aligned splats to collider. Level size ~', sz.x.toFixed(1), sz.y.toFixed(1), sz.z.toFixed(1));
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

async function isSplatRadAvailable(url) {
  try {
    let res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return true;
    if (res.status === 405) {
      res = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      return res.ok || res.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Spark 2.0: load pre-built LoD `.rad` when present, else `.spz` with `lod: true`.
 * @see https://sparkjs.dev/2.0.0-preview/docs/lod-getting-started/
 */
async function createRuinsSplatMesh() {
  if (sparkRenderer) {
    sparkRenderer.pagedExtSplats = !!(splatLoadParams.extSplats && splatLoadParams.pagedStreaming);
  }
  const ext = splatLoadParams.extSplats;
  if (splatLoadParams.preferRad && (await isSplatRadAvailable(ASSETS.splatRad))) {
    console.info('[TombVaider] Loading pre-built LoD:', ASSETS.splatRad);
    const opts = { url: ASSETS.splatRad };
    if (ext) opts.extSplats = true;
    if (splatLoadParams.pagedStreaming) opts.paged = true;
    return new SplatMesh(opts);
  }
  console.info(
    '[TombVaider] No',
    ASSETS.splatRad,
    '— using',
    ASSETS.splatSpz,
    'with lod:true. Pre-build:',
    'npm run build:rad -- public/ruins.spz --quality'
  );
  const fallback = { url: ASSETS.splatSpz, lod: true };
  if (ext) fallback.extSplats = true;
  return new SplatMesh(fallback);
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

  /** Large `.rad` / `.spz` can take many minutes on first load. */
  const loadingSafetyMs = 900000;
  const clearLoadingSafety = (() => {
    const id = setTimeout(() => {
      console.warn(
        '[TombVaider] Loading screen cleared (timeout). Check Network for failed or huge assets (.spz can be very large; prefer ruins-lod.rad).'
      );
      setLoadingVisible(false);
    }, loadingSafetyMs);
    return () => clearTimeout(id);
  })();

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
      colliderRoot.visible = layerParams.showColliderMesh;
      collidersReady = colliderMeshes.length > 0;

      void (async () => {
        setLoadingVisible(true, 'Loading splats (Spark 2.0 LoD) — large .rad can take several minutes…');
        let ruins;
        try {
          ruins = await createRuinsSplatMesh();
        } catch (e) {
          console.error('[TombVaider] createRuinsSplatMesh failed:', e);
          clearLoadingSafety();
          setLoadingVisible(false);
          return;
        }
        ruinsSplat = ruins;
        ruins.visible = layerParams.showSplat;
        ruins.frustumCulled = false;
        ruins.quaternion.copy(sparkFlipQuat);
        worldRoot.add(ruins);

        try {
          await ruins.initialized;
          try {
            alignRuinsToCollider(ruins, colliderRoot);
            snapCharacterToGround();
          } catch (e) {
            console.error('[TombVaider] alignRuinsToCollider failed:', e);
          }
          clearLoadingSafety();
          setLoadingVisible(false);
        } catch (err) {
          console.error('Ruins splat failed:', err);
          clearLoadingSafety();
          setLoadingVisible(true, 'Could not load splats — check Network tab / public/ruins-lod.rad');
          setTimeout(() => setLoadingVisible(false), 12000);
        }
      })();

      if (viewParams.showCharacter) loadCharacterModel(gltfLoader);
    },
    undefined,
    (err) => {
      console.error('Collider GLB failed:', err);
      clearLoadingSafety();
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
  const forward =
    keys['KeyW'] || keys['ArrowUp'] ? 1 : keys['KeyS'] || keys['ArrowDown'] ? -1 : 0;
  const strafe =
    keys['KeyD'] || keys['ArrowRight'] ? 1 : keys['KeyA'] || keys['ArrowLeft'] ? -1 : 0;
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

  const verticalFly = keys['KeyQ'] ? 1 : keys['KeyE'] ? -1 : 0;
  if (verticalFly !== 0) {
    characterRoot.position.y += verticalFly * physicsParams.flyVerticalSpeed * delta;
    velocity.y = 0;
    isGrounded = false;
  } else {
    if (keys['Space'] && isGrounded) {
      velocity.y = physicsParams.jumpVelocity;
      isGrounded = false;
      playAction('jump', 0.1);
    }
    velocity.y += physicsParams.gravity * delta;
  }

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
      if (document.pointerLockElement) {
        cameraYaw = angle;
      } else if (!lookDragActive) {
        cameraYaw = angle;
      }
    } else if (document.pointerLockElement) {
      character.rotation.y = cameraYaw;
    } else if (lookDragActive) {
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

  if (orbitControls && cameraParams.freeOrbit) {
    orbitControls.update();
    return;
  }

  const targetPos = characterRoot.position.clone();
  targetPos.y += 3;
  const yaw = cameraYaw;
  const fd = THREE.MathUtils.clamp(
    cameraParams.followDistance,
    MIN_FOLLOW_DISTANCE,
    MAX_FOLLOW_DISTANCE
  );
  if (fd !== cameraParams.followDistance) cameraParams.followDistance = fd;
  const camOffset = new THREE.Vector3(0, cameraParams.followHeight, fd);
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

  diagFrame = (diagFrame + 1) % 45;
  if (splatDiagEl && diagFrame === 0) {
    if (!ruinsSplat) {
      splatDiagEl.textContent = 'Splats: (not created yet)';
    } else if (!ruinsSplat.isInitialized) {
      splatDiagEl.textContent = 'Splats: decoding / LoD prep… (large .rad can take minutes)';
    } else {
      let n = 0;
      try {
        n = ruinsSplat.getNumSplats();
      } catch (_) {
        n = -1;
      }
      splatDiagEl.textContent =
        `Spark: ${n >= 0 ? n.toLocaleString() + ' splats (source)' : 'ready'} · camera far ${camera.far.toFixed(0)}`;
    }
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

init();
