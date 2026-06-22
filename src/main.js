import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// DOM Elements
const loaderOverlay = document.getElementById('loader');
const progressBar = document.getElementById('progress-bar');
const progressPercent = document.getElementById('progress-percent');
const previewContainer = document.getElementById('canvas-preview');
const enterArBtn = document.getElementById('enter-ar-btn');
const arOverlay = document.getElementById('ar-overlay');
const exitArBtn = document.getElementById('exit-ar-btn');
const arInstruction = document.getElementById('ar-instruction');
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');
const rotationSlider = document.getElementById('rotation-slider');
const rotationValue = document.getElementById('rotation-value');
const resetArObjBtn = document.getElementById('reset-ar-obj-btn');
const repositionBtn = document.getElementById('reposition-btn');
const errorModal = document.getElementById('error-modal');
const closeErrorBtn = document.getElementById('close-error-btn');

// Global App Variables
let width = previewContainer.clientWidth;
let height = previewContainer.clientHeight;

let scene, renderer, previewCamera, previewControls;
let dirLight, hemiLight, shadowPlane;
let loadedModelGroup = null; // The parent group holding the auto-centered model
let rawGltfScene = null; // Storing the loaded GLTF content
let baseScale = 1.0;
let isArMode = false;
let modelPlaced = false;

// WebXR specific variables
let xrSession = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle = null;
let overlayTouched = false;

// Initialize standard 3D Viewer Scene
function init() {
  // Scene
  scene = new THREE.Scene();
  // Set nice deep blue-dark background for preview container
  scene.background = null; // transparent to show card gradient

  // Camera
  previewCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  previewCamera.position.set(0, 1.5, 3.5);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0); // Pastikan background render transparan
  previewContainer.appendChild(renderer.domElement);

  // Controls
  previewControls = new OrbitControls(previewCamera, renderer.domElement);
  previewControls.enableDamping = true;
  previewControls.dampingFactor = 0.05;
  previewControls.maxPolarAngle = Math.PI / 2 + 0.1; // Don't go below ground
  previewControls.minDistance = 1.5;
  previewControls.maxDistance = 10;

  // Lights
  hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  hemiLight.position.set(0, 20, 0);
  scene.add(hemiLight);

  dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
  dirLight.position.set(5, 10, 7);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 15;
  const d = 3;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);

  // Shadow receiver plane (invisible ground plane that receives shadows)
  const shadowPlaneGeo = new THREE.PlaneGeometry(30, 30);
  shadowPlaneGeo.rotateX(-Math.PI / 2);
  const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.4 });
  shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  shadowPlane.receiveShadow = true;
  shadowPlane.position.y = 0; // Base ground height
  scene.add(shadowPlane);

  // AR Reticle (indicator ring)
  const ringGeo = new THREE.RingGeometry(0.12, 0.15, 32).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ 
    color: 0x8b5cf6, 
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.8
  });
  reticle = new THREE.Mesh(ringGeo, ringMat);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Setup simple axes/grid helper for visual aesthetics in preview (hidden in AR)
  const gridHelper = new THREE.GridHelper(10, 20, 0x8b5cf6, 0x2e303a);
  gridHelper.position.y = -0.01;
  gridHelper.material.opacity = 0.2;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  // Load the 3D GLB Model
  loadModel();

  // Handle resizing
  window.addEventListener('resize', onWindowResize);

  // Begin Preview Loop
  animate();
}

// Load Model using GLTFLoader
function loadModel() {
  const loader = new GLTFLoader();

  // Fetch logo.glb from the public folder (using relative path for GitHub Pages compatibility)
  loader.load(
    './logo.glb',
    (gltf) => {
      rawGltfScene = gltf.scene;

      // Enable casting/receiving shadows for all meshes
      rawGltfScene.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          
          // Optimize materials for clean PBR display
          if (child.material) {
            child.material.roughness = Math.max(child.material.roughness, 0.2);
            child.material.metalness = Math.min(child.material.metalness, 0.9);
          }
        }
      });

      // Calculate Bounding Box to center pivot and scale properly
      const box = new THREE.Box3().setFromObject(rawGltfScene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const min = box.min;

      // Base scale: scale it so its largest dimension is exactly 1.0 unit (meters)
      const maxDim = Math.max(size.x, size.y, size.z);
      baseScale = 1.0 / maxDim;
      
      // Setup the parent group for ease of positioning
      loadedModelGroup = new THREE.Group();
      scene.add(loadedModelGroup);

      // Add model to parent group and shift its pivot so that bottom center is at (0, 0, 0)
      rawGltfScene.scale.setScalar(baseScale);
      rawGltfScene.position.set(
        -center.x * baseScale,
        -min.y * baseScale,
        -center.z * baseScale
      );
      loadedModelGroup.add(rawGltfScene);

      // Hide loader
      loaderOverlay.style.opacity = '0';
      setTimeout(() => {
        loaderOverlay.style.display = 'none';
      }, 500);

      // Position camera nicely depending on object height
      previewCamera.position.set(0, size.y * baseScale * 0.8 + 0.5, 2.2);
      previewCamera.lookAt(0, size.y * baseScale * 0.5, 0);
      previewControls.target.set(0, size.y * baseScale * 0.5, 0);
      previewControls.update();
    },
    (xhr) => {
      // Progress calculation
      if (xhr.total) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        progressBar.style.width = percent + '%';
        progressPercent.textContent = percent + '%';
      } else {
        // Fallback for missing length headers
        const loadedMB = (xhr.loaded / (1024 * 1024)).toFixed(1);
        progressBar.style.width = '60%';
        progressPercent.textContent = `${loadedMB} MB`;
      }
    },
    (error) => {
      console.error('Error loading the GLB model:', error);
      const loaderText = loaderOverlay.querySelector('.loader-text');
      if (loaderText) loaderText.textContent = 'Gagal memuat model. Hubungi admin atau coba lagi.';
      const spinner = loaderOverlay.querySelector('.spinner');
      if (spinner) spinner.style.borderLeftColor = '#ef4444';
    }
  );
}

// Window resize handler
function onWindowResize() {
  if (isArMode) return; // Ignore resizing when in immersive WebXR mode

  width = previewContainer.clientWidth;
  height = previewContainer.clientHeight;

  previewCamera.aspect = width / height;
  previewCamera.updateProjectionMatrix();

  renderer.setSize(width, height);
}

// Interactive Preview Loop
function animate() {
  if (isArMode) return; // Exit loop if we're in WebXR rendering mode

  requestAnimationFrame(animate);

  // Slow idle rotation of the model if loaded and user is not interacting
  if (loadedModelGroup && !previewControls.state === -1) {
    loadedModelGroup.rotation.y += 0.005;
  } else if (loadedModelGroup) {
    // Slowly rotate when idle
    loadedModelGroup.rotation.y += 0.003;
  }

  previewControls.update();
  renderer.render(scene, previewCamera);
}

// ==========================================================================
// WebXR Augmented Reality Logic
// ==========================================================================

// Trigger check and start AR Session
async function startArExperience() {
  if (!loadedModelGroup) {
    alert('Model belum selesai diunduh. Tunggu beberapa saat.');
    return;
  }

  // Check if WebXR is supported
  if ('xr' in navigator) {
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      if (supported) {
        // Setup options
        const sessionInit = {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay'],
          domOverlay: { root: arOverlay }
        };

        // Request immersive session
        const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
        onSessionStarted(session);
      } else {
        showArNotSupported();
      }
    } catch (err) {
      console.error('WebXR session support check failed:', err);
      showArNotSupported();
    }
  } else {
    showArNotSupported();
  }
}

// AR Session initiation
async function onSessionStarted(session) {
  xrSession = session;
  isArMode = true;
  modelPlaced = false;

  // Move canvas to body so it remains active and visible in DOM
  document.body.appendChild(renderer.domElement);
  
  // Style canvas to not affect page layout if needed
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.zIndex = '-1';
  renderer.domElement.style.pointerEvents = 'none';

  // Toggle DOM Visibilities & Apply transparency class
  document.body.classList.add('ar-active');
  document.documentElement.classList.add('ar-active');
  document.getElementById('app').style.display = 'none';
  arOverlay.style.display = 'flex';

  // Make sure model starts invisible and positioned at center in AR (awaiting placement)
  loadedModelGroup.visible = false;
  loadedModelGroup.position.set(0, 0, 0);
  loadedModelGroup.rotation.set(0, 0, 0);
  loadedModelGroup.scale.setScalar(1.0); // Reset scale to 1.0 (relative to baseScale)

  // Reset Sliders
  scaleSlider.value = 1.0;
  scaleValue.textContent = '1.0x';
  rotationSlider.value = 0;
  rotationValue.textContent = '0°';

  // Set instructions
  arInstruction.classList.remove('success');
  arInstruction.textContent = 'Arahkan kamera ke lantai & gerakkan perlahan untuk mendeteksi permukaan';

  // Tell renderer to use XR session
  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);

  // WebXR session event listeners
  session.addEventListener('end', onSessionEnded);
  session.addEventListener('select', onArSelect);

  // Set hit test state flags
  hitTestSourceRequested = false;
  hitTestSource = null;

  // Run the XR rendering loop
  renderer.setAnimationLoop(xrRender);
}

// AR Session cleanup
function onSessionEnded() {
  xrSession = null;
  isArMode = false;

  // Move canvas back to preview container
  previewContainer.appendChild(renderer.domElement);
  
  // Restore style
  renderer.domElement.style.position = '';
  renderer.domElement.style.top = '';
  renderer.domElement.style.left = '';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.zIndex = '';
  renderer.domElement.style.pointerEvents = '';

  // Restore DOM Visibilities & Remove transparency class
  document.body.classList.remove('ar-active');
  document.documentElement.classList.remove('ar-active');
  document.getElementById('app').style.display = 'flex';
  arOverlay.style.display = 'none';

  // Disable XR on renderer to fallback to preview viewer
  renderer.xr.enabled = false;

  // Reset Model properties for preview
  if (loadedModelGroup) {
    loadedModelGroup.visible = true;
    loadedModelGroup.position.set(0, 0, 0);
    loadedModelGroup.rotation.set(0, 0, 0);
    loadedModelGroup.scale.setScalar(1.0);
  }

  // Restore helper grid position
  shadowPlane.position.y = 0;

  // Reset lights positions
  dirLight.position.set(5, 10, 7);
  dirLight.target = new THREE.Object3D(); // Point light back to general origin

  // Re-trigger viewport resize and restart OrbitControls loop
  onWindowResize();
  animate();
}

// WebXR Animation Loop
function xrRender(timestamp, frame) {
  if (!frame) return;

  const session = renderer.xr.getSession();
  const referenceSpace = renderer.xr.getReferenceSpace();

  // Create hit test source if not initialized
  if (!hitTestSourceRequested) {
    session.requestReferenceSpace('viewer').then((viewerSpace) => {
      session.requestHitTestSource({ space: viewerSpace }).then((source) => {
        hitTestSource = source;
      });
    });

    session.addEventListener('end', () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
    });

    hitTestSourceRequested = true;
  }

  // Run hit test
  if (hitTestSource) {
    const hitTestResults = frame.getHitResults(hitTestSource);

    if (hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(referenceSpace);

      // Show reticle and update position matrix
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);

      // Update instructions
      if (!modelPlaced) {
        arInstruction.classList.add('success');
        arInstruction.textContent = 'Permukaan terdeteksi! Ketuk layar untuk menempatkan model';
      }
    } else {
      reticle.visible = false;
      if (!modelPlaced) {
        arInstruction.classList.remove('success');
        arInstruction.textContent = 'Gerakkan kamera perlahan di permukaan datar...';
      }
    }
  }

  // Dynamically update light position to follow model to keep shadows accurate
  if (loadedModelGroup && modelPlaced) {
    dirLight.position.set(
      loadedModelGroup.position.x + 2.5,
      loadedModelGroup.position.y + 4.0,
      loadedModelGroup.position.z + 1.5
    );
    dirLight.target = loadedModelGroup;
  }

  renderer.render(scene, previewCamera);
}

// Proxy to get active XR camera safely from renderer (since camera changes in WebXR)
function cameraProxyXR() {
  return renderer.xr.getCamera();
}

// WebXR Screen Tap (Select)
function onArSelect() {
  // If user tapped on active HTML controls, ignore placement action
  if (overlayTouched) return;

  if (reticle.visible && loadedModelGroup) {
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    // Get position and rotation from the hit reticle matrix
    reticle.matrix.decompose(position, rotation, scale);

    // Place model at reticle pose
    loadedModelGroup.position.copy(position);
    
    // Check if it's the first time placing
    if (!modelPlaced) {
      loadedModelGroup.visible = true;
      modelPlaced = true;
      
      // Update instruction banner
      arInstruction.classList.add('success');
      arInstruction.textContent = 'Model berhasil ditempatkan! Gunakan kontrol untuk menyesuaikan';
      
      // Ground the shadow plane at the placed level
      shadowPlane.position.y = position.y;

      // Animate scale in (from 0 to 1.0) for a slick loading pop effect
      loadedModelGroup.scale.set(0, 0, 0);
      let targetScale = parseFloat(scaleSlider.value);
      
      // Simple custom linear interpolation for scale-up animation
      let animProgress = 0;
      const animInterval = setInterval(() => {
        animProgress += 0.1;
        if (animProgress >= 1) {
          loadedModelGroup.scale.setScalar(targetScale);
          clearInterval(animInterval);
        } else {
          // Cubic ease-out
          const ease = 1 - Math.pow(1 - animProgress, 3);
          loadedModelGroup.scale.setScalar(targetScale * ease);
        }
      }, 20);
    } else {
      // Just translate to new reticle point smoothly
      loadedModelGroup.position.copy(position);
      shadowPlane.position.y = position.y;
    }
  }
}

// Exit AR session
function exitArExperience() {
  if (xrSession) {
    xrSession.end();
  }
}

// Show Warning Modal
function showArNotSupported() {
  errorModal.classList.add('active');
}

// Reset placing and scale
function resetArObject() {
  if (loadedModelGroup) {
    loadedModelGroup.position.set(0, 0, 0);
    loadedModelGroup.rotation.set(0, 0, 0);
    loadedModelGroup.scale.setScalar(1.0);
    modelPlaced = false;
    loadedModelGroup.visible = false;
    shadowPlane.position.y = 0;
    
    // Reset sliders
    scaleSlider.value = 1.0;
    scaleValue.textContent = '1.0x';
    rotationSlider.value = 0;
    rotationValue.textContent = '0°';

    arInstruction.classList.remove('success');
    arInstruction.textContent = 'Arahkan kamera ke lantai & ketuk untuk memutar ulang model';
  }
}

// Force reposition model to current reticle manually
function forceReposition() {
  if (reticle.visible && loadedModelGroup) {
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    reticle.matrix.decompose(position, rotation, scale);
    loadedModelGroup.position.copy(position);
    shadowPlane.position.y = position.y;
    loadedModelGroup.visible = true;
    modelPlaced = true;
    
    arInstruction.classList.add('success');
    arInstruction.textContent = 'Model dipindahkan ke permukaan baru';
  } else {
    alert('Permukaan datar belum terdeteksi. Pindahkan kamera HP secara perlahan.');
  }
}

// ==========================================================================
// Setup Listeners and UI Controls bindings
// ==========================================================================

// Binding event listeners for AR buttons and sliders
function setupUIListeners() {
  enterArBtn.addEventListener('click', startArExperience);
  exitArBtn.addEventListener('click', exitArExperience);
  closeErrorBtn.addEventListener('click', () => {
    errorModal.classList.remove('active');
  });

  // Slider Scale
  scaleSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    scaleValue.textContent = val.toFixed(1) + 'x';
    if (loadedModelGroup && modelPlaced) {
      loadedModelGroup.scale.setScalar(val);
    }
  });

  // Slider Rotation
  rotationSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    rotationValue.textContent = val + '°';
    if (loadedModelGroup && modelPlaced) {
      // Convert degrees to radians
      loadedModelGroup.rotation.y = THREE.MathUtils.degToRad(val);
    }
  });

  // Action Buttons
  resetArObjBtn.addEventListener('click', resetArObject);
  repositionBtn.addEventListener('click', forceReposition);

  // Prevent WebXR touch placements when adjusting UI
  const arOverlayPanel = document.querySelector('.ar-bottom-panel');
  const arOverlayTop = document.querySelector('.ar-top-bar');

  [arOverlayPanel, arOverlayTop].forEach((panel) => {
    if (!panel) return;
    
    // Multi-platform touch interception
    panel.addEventListener('touchstart', () => { overlayTouched = true; }, { passive: true });
    panel.addEventListener('touchend', () => { 
      setTimeout(() => { overlayTouched = false; }, 80); 
    }, { passive: true });
    panel.addEventListener('mousedown', () => { overlayTouched = true; });
    panel.addEventListener('mouseup', () => { 
      setTimeout(() => { overlayTouched = false; }, 80); 
    });
  });
}

// Run App Init on Load
document.addEventListener('DOMContentLoaded', () => {
  init();
  setupUIListeners();
});
