import { useEffect, useRef, useState, useMemo } from 'react';
import { X, RotateCcw, Layers, Eye, Search, Package, Map, AlertTriangle, Activity, ChevronDown } from 'lucide-react';
import type { Container, Street } from '../types';
import type { ContainerStatusDef } from '../lib/containerStatus';
import type { ContainerTypeDef } from '../lib/containerTypes';
import type { YardSpace } from '../types';

interface Props {
  containers: Container[];
  streets: Street[];
  containerStatuses: ContainerStatusDef[];
  containerTypes: ContainerTypeDef[];
  spaces: YardSpace[];
  activeSpaceId: string;
  onClose: () => void;
}

// ─── Three.js types (loaded via CDN script tag) ───────────────────────────
declare const THREE: any;

export default function YardView3D({
  containers, streets, containerStatuses, containerTypes,
  spaces, activeSpaceId, onClose,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const animFrameRef = useRef<number>(0);
  const containerMeshesRef = useRef<any[]>([]);
  const edgeMeshesRef = useRef<any[]>([]);

  const [search, setSearch] = useState('');
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [loaded, setLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<'iso' | 'top' | 'front'>('iso');

  const activeSpace = spaces.find(s => s.id === activeSpaceId) ?? spaces[0];
  const numCols = activeSpace?.numCols ?? 20;
  const numRows = activeSpace?.numRows ?? 20;

  // ─── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    containerStatuses.forEach(s => { byStatus[s.id] = containers.filter(c => c.status === s.id).length; });
    const maxHeight = Math.max(...containers.map(c => c.height ?? 0), 0);
    return { total: containers.length, byStatus, maxHeight };
  }, [containers, containerStatuses]);

  const filteredContainers = useMemo(() => {
    return containers.filter(c => {
      const matchStatus = filterStatus === 'all' || c.status === filterStatus;
      const matchSearch = !search || c.id.toLowerCase().includes(search.toLowerCase());
      return matchStatus && matchSearch;
    });
  }, [containers, filterStatus, search]);

  // ─── Get status color ─────────────────────────────────────────────────────
  const getStatusColor = (statusId: string): string => {
    const sd = containerStatuses.find(s => s.id === statusId);
    return sd?.border ?? '#475569';
  };

  // ─── Parse position ───────────────────────────────────────────────────────
  const parsePosition = (pos: string): { col: number; row: number } | null => {
    const match = pos.match(/^(\d{1,3})([A-Z]{1,2})$/);
    if (!match) return null;
    const col = parseInt(match[1], 10) - 1;
    const rowLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const rowStr = match[2];
    let row = 0;
    for (let i = 0; i < rowStr.length; i++) {
      row = row * 26 + rowLetters.indexOf(rowStr[i]);
    }
    return { col, row };
  };

  // ─── Load Three.js and build scene ───────────────────────────────────────
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    script.onload = () => initScene();
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (rendererRef.current && wrapRef.current) {
        wrapRef.current.removeChild(rendererRef.current.domElement);
        rendererRef.current.dispose();
      }
    };
  }, []);

  // ─── Rebuild meshes when containers change ────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current || !loaded) return;
    rebuildContainers();
  }, [containers, containerStatuses, loaded]);

  const initScene = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const W = wrap.clientWidth;
    const H = wrap.clientHeight;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x0a0c10);
    renderer.setSize(W, H);
    wrap.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0c10, 0.008);
    sceneRef.current = scene;

    // Camera (orthographic for yard feel)
    const aspect = W / H;
    const frustum = 12;
    const camera = new THREE.OrthographicCamera(
      -frustum * aspect, frustum * aspect, frustum, -frustum, -200, 500
    );
    camera.position.set(20, 18, 20);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(-12, 20, 8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 0.1;
    dir.shadow.camera.far = 200;
    dir.shadow.camera.left = -60;
    dir.shadow.camera.right = 60;
    dir.shadow.camera.top = 60;
    dir.shadow.camera.bottom = -60;
    scene.add(dir);
    scene.add(new THREE.HemisphereLight(0xe8f4ff, 0xb0c0a8, 0.3));

    // Ground
    const cellW = 1.2, cellD = 2.4;
    const gW = numCols * cellW + 4;
    const gD = numRows * cellD + 4;
    const groundGeo = new THREE.PlaneGeometry(gW, gD);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.set((numCols * cellW) / 2, -0.01, (numRows * cellD) / 2);
    scene.add(ground);

    // Grid lines
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1e3050, transparent: true, opacity: 0.6 });
    for (let c = 0; c <= numCols; c++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c * cellW, 0, 0),
        new THREE.Vector3(c * cellW, 0, numRows * cellD),
      ]);
      scene.add(new THREE.Line(geo, gridMat));
    }
    for (let r = 0; r <= numRows; r++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, r * cellD),
        new THREE.Vector3(numCols * cellW, 0, r * cellD),
      ]);
      scene.add(new THREE.Line(geo, gridMat));
    }

    // Build containers
    rebuildContainers();

    // Orbit controls (manual)
    let isDragging = false;
    let prevMouse = { x: 0, y: 0 };
    let theta = Math.PI / 4, phi = Math.PI / 5, radius = 28;
    let targetTheta = theta, targetPhi = phi, targetRadius = radius;
    const targetPos = new THREE.Vector3((numCols * cellW) / 2, 0, (numRows * cellD) / 2);

    const updateCam = () => {
      camera.position.set(
        targetPos.x + radius * Math.sin(phi) * Math.sin(theta),
        targetPos.y + radius * Math.cos(phi),
        targetPos.z + radius * Math.sin(phi) * Math.cos(theta)
      );
      camera.lookAt(targetPos);
      const asp = wrap.clientWidth / wrap.clientHeight;
      const f = radius * 0.3;
      camera.left = -f * asp; camera.right = f * asp;
      camera.top = f; camera.bottom = -f;
      camera.updateProjectionMatrix();
    };

    wrap.addEventListener('mousedown', e => { isDragging = true; prevMouse = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const dx = e.clientX - prevMouse.x, dy = e.clientY - prevMouse.y;
      prevMouse = { x: e.clientX, y: e.clientY };
      targetTheta -= dx * 0.007;
      targetPhi = Math.max(0.1, Math.min(Math.PI * 0.48, targetPhi + dy * 0.005));
    });
    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      targetRadius = Math.max(5, Math.min(60, targetRadius + e.deltaY * 0.04));
    }, { passive: false });

    // Touch support
    let lastTouchDist = 0;
    wrap.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        isDragging = true;
        prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    });
    wrap.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging) {
        const dx = e.touches[0].clientX - prevMouse.x;
        const dy = e.touches[0].clientY - prevMouse.y;
        prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        targetTheta -= dx * 0.007;
        targetPhi = Math.max(0.1, Math.min(Math.PI * 0.48, targetPhi + dy * 0.005));
      } else if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        targetRadius = Math.max(5, Math.min(60, targetRadius - (dist - lastTouchDist) * 0.05));
        lastTouchDist = dist;
      }
    }, { passive: false });
    wrap.addEventListener('touchend', () => { isDragging = false; });

    // Raycasting for click
    const raycaster = new THREE.Raycaster();
    const mouse2 = new THREE.Vector2();
    wrap.addEventListener('click', e => {
      if (isDragging) return;
      const rect = wrap.getBoundingClientRect();
      mouse2.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse2.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse2, camera);
      const hits = raycaster.intersectObjects(containerMeshesRef.current.filter(m => m.visible));
      if (hits.length > 0) {
        const id = hits[0].object.userData.containerId;
        const c = containers.find(c => c.id === id);
        setSelectedContainer(c ?? null);
      } else {
        setSelectedContainer(null);
      }
    });

    // Camera preset controls (exposed via ref pattern with custom events)
    const handleViewChange = (e: any) => {
      const v = e.detail;
      if (v === 'iso') { targetTheta = Math.PI / 4; targetPhi = Math.PI / 5; targetRadius = 28; }
      if (v === 'top') { targetPhi = 0.08; targetRadius = 35; }
      if (v === 'front') { targetPhi = Math.PI * 0.45; targetTheta = 0; targetRadius = 28; }
      if (v === 'reset') { targetTheta = Math.PI / 4; targetPhi = Math.PI / 5; targetRadius = 28; targetPos.set((numCols * cellW) / 2, 0, (numRows * cellD) / 2); }
    };
    wrap.addEventListener('yard3d-view', handleViewChange as any);

    // Resize
    const onResize = () => {
      if (!wrap) return;
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
      updateCam();
    };
    window.addEventListener('resize', onResize);

    // Animate
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      theta += (targetTheta - theta) * 0.08;
      phi += (targetPhi - phi) * 0.08;
      radius += (targetRadius - radius) * 0.08;
      updateCam();
      renderer.render(scene, camera);
    };

    setTimeout(() => {
      setLoaded(true);
      animate();
    }, 800);
  };

  const rebuildContainers = () => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old meshes
    containerMeshesRef.current.forEach(m => scene.remove(m));
    edgeMeshesRef.current.forEach(m => scene.remove(m));
    containerMeshesRef.current = [];
    edgeMeshesRef.current = [];

    const cellW = 1.2, cellD = 2.4;
    const cH = 0.45; // container height unit
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 });

    const matCache: Record<string, any> = {};
    const getMat = (hex: string) => {
      if (!matCache[hex]) {
        const c = new THREE.Color(hex);
        matCache[hex] = new THREE.MeshStandardMaterial({
          color: c, roughness: 0.7, metalness: 0.2,
        });
      }
      return matCache[hex];
    };

    containers.forEach(c => {
      const parsed = parsePosition(c.position);
      if (!parsed) return;
      const { col, row } = parsed;
      if (col >= numCols || row >= numRows) return;

      const isType40 = c.type.startsWith('40');
      const w = isType40 ? cellW * 0.85 : cellW * 0.55;
      const d = cellD * 0.85;
      const h = cH;

      const geo = new THREE.BoxGeometry(w, h, d);
      const color = getStatusColor(c.status);
      const mat = getMat(color).clone();

      // Highlight selected
      if (selectedContainer?.id === c.id) {
        mat.emissive = new THREE.Color(0x224422);
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const x = col * cellW + cellW / 2;
      const y = (c.height ?? 0) * h + h / 2;
      const z = row * cellD + cellD / 2;
      mesh.position.set(x, y, z);
      mesh.userData = { containerId: c.id, status: c.status, type: c.type };

      // Visibility
      const inFilter = filterStatus === 'all' || c.status === filterStatus;
      const inSearch = !search || c.id.toLowerCase().includes(search.toLowerCase());
      mesh.visible = inFilter && inSearch;

      scene.add(mesh);
      containerMeshesRef.current.push(mesh);

      // Edges
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        edgeMat.clone()
      );
      edges.position.copy(mesh.position);
      edges.visible = mesh.visible;
      scene.add(edges);
      edgeMeshesRef.current.push(edges);
    });
  };

  // Rebuild when filters/search change
  useEffect(() => {
    if (!loaded) return;
    containerMeshesRef.current.forEach((m, i) => {
      const cid = m.userData.containerId;
      const c = containers.find(c => c.id === cid);
      if (!c) return;
      const inFilter = filterStatus === 'all' || c.status === filterStatus;
      const inSearch = !search || c.id.toLowerCase().includes(search.toLowerCase());
      m.visible = inFilter && inSearch;
      if (edgeMeshesRef.current[i]) edgeMeshesRef.current[i].visible = m.visible;
    });
  }, [filterStatus, search, loaded]);

  const handleView = (v: string) => {
    setViewMode(v as any);
    wrapRef.current?.dispatchEvent(new CustomEvent('yard3d-view', { detail: v }));
  };

  const statusDef = selectedContainer
    ? containerStatuses.find(s => s.id === selectedContainer.status)
    : null;
  const typeDef = selectedContainer
    ? containerTypes.find(t => t.id === selectedContainer.type)
    : null;

  const visibleCount = containerMeshesRef.current.filter(m => m.visible).length;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 70,
      background: '#0a0c10',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'JetBrains Mono', monospace",
      overflow: 'hidden',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@600;700&display=swap');
        .yard3d-panel::-webkit-scrollbar { width: 4px; }
        .yard3d-panel::-webkit-scrollbar-track { background: transparent; }
        .yard3d-panel::-webkit-scrollbar-thumb { background: #1e2530; border-radius: 2px; }
        .yard3d-btn { transition: all 0.15s; }
        .yard3d-btn:hover { border-color: #00d4ff !important; color: #00d4ff !important; }
        .yard3d-stat { background: #111820; border: 1px solid #1e2530; border-radius: 6px; padding: 10px 12px; }
        .yard3d-filter:hover { border-color: #1e3050 !important; background: #111820 !important; }
        @media (max-width: 640px) {
          .yard3d-sidebar { width: 100% !important; min-width: 100% !important; height: 220px !important; border-right: none !important; border-bottom: 1px solid #1e2530 !important; flex-direction: row !important; overflow-x: auto !important; overflow-y: hidden !important; flex-wrap: nowrap !important; }
          .yard3d-layout { flex-direction: column !important; }
        }
      `}</style>

      {/* ── Top bar ── */}
      <div style={{
        height: 50, flexShrink: 0, background: '#0f1318',
        borderBottom: '1px solid #1e2530',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Layers size={16} color="#00d4ff" />
          <div>
            <p style={{ fontSize: 9, letterSpacing: '0.15em', color: '#6b7a90', margin: 0, fontFamily: "'Syne', sans-serif" }}>
              {activeSpace?.name?.toUpperCase() ?? 'PÁTIO'} — VISUALIZAÇÃO 3D
            </p>
            <h1 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', margin: 0, fontFamily: "'Syne', sans-serif", letterSpacing: '0.05em' }}>
              YARD VIEWER 3D
            </h1>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Live badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: '#0f2a1a', border: '1px solid #22c55e44' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block', boxShadow: '0 0 6px #22c55e' }} />
            <span style={{ fontSize: 9, color: '#4ade80', fontWeight: 700, letterSpacing: '0.08em' }}>
              {containers.length} UNIDADES
            </span>
          </div>

          {/* View presets */}
          {(['iso', 'top', 'front'] as const).map(v => (
            <button key={v} onClick={() => handleView(v)}
              className="yard3d-btn"
              style={{
                padding: '5px 10px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                background: viewMode === v ? '#1e3a5f' : '#151b23',
                border: `1px solid ${viewMode === v ? '#00d4ff' : '#1e2530'}`,
                color: viewMode === v ? '#00d4ff' : '#6b7a90',
                cursor: 'pointer', letterSpacing: '0.05em', fontFamily: "'JetBrains Mono', monospace",
              }}>
              {v.toUpperCase()}
            </button>
          ))}

          <button onClick={() => handleView('reset')}
            className="yard3d-btn"
            style={{
              width: 32, height: 32, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#151b23', border: '1px solid #1e2530', color: '#6b7a90', cursor: 'pointer',
            }}>
            <RotateCcw size={13} />
          </button>

          <button onClick={onClose}
            className="yard3d-btn"
            style={{
              width: 32, height: 32, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#151b23', border: '1px solid #1e2530', color: '#6b7a90', cursor: 'pointer',
            }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="yard3d-layout" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Sidebar ── */}
        <div className="yard3d-panel yard3d-sidebar" style={{
          width: 240, minWidth: 240, background: '#0f1318',
          borderRight: '1px solid #1e2530',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto', flexShrink: 0,
        }}>

          {/* Search */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #1e2530' }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#6b7a90', margin: '0 0 8px', textTransform: 'uppercase' }}>Buscar</p>
            <div style={{ position: 'relative' }}>
              <Search size={11} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#6b7a90' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="ID do container..."
                style={{
                  width: '100%', paddingLeft: 28, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
                  background: '#151b23', border: '1px solid #1e2530', borderRadius: 5,
                  color: '#e2e8f0', fontSize: 11, outline: 'none', fontFamily: "'JetBrains Mono', monospace",
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Status filters */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #1e2530' }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#6b7a90', margin: '0 0 10px', textTransform: 'uppercase' }}>Status</p>
            <button
              onClick={() => setFilterStatus('all')}
              className="yard3d-filter"
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 8px', borderRadius: 5, marginBottom: 5, cursor: 'pointer',
                background: filterStatus === 'all' ? '#1e3a5f' : 'transparent',
                border: `1px solid ${filterStatus === 'all' ? '#00d4ff44' : 'transparent'}`,
              }}>
              <span style={{ fontSize: 11, color: filterStatus === 'all' ? '#00d4ff' : '#e2e8f0' }}>Todos</span>
              <span style={{ fontSize: 10, color: '#6b7a90' }}>{containers.length}</span>
            </button>
            {containerStatuses.map(s => (
              <button key={s.id}
                onClick={() => setFilterStatus(s.id)}
                className="yard3d-filter"
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', borderRadius: 5, marginBottom: 4, cursor: 'pointer',
                  background: filterStatus === s.id ? `${s.border}18` : 'transparent',
                  border: `1px solid ${filterStatus === s.id ? `${s.border}44` : 'transparent'}`,
                }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: s.border, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: filterStatus === s.id ? s.text : '#e2e8f0', flex: 1, textAlign: 'left' }}>{s.label}</span>
                <span style={{ fontSize: 10, color: '#6b7a90' }}>{stats.byStatus[s.id] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* Stats */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #1e2530' }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#6b7a90', margin: '0 0 10px', textTransform: 'uppercase' }}>Pátio</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { label: 'TOTAL', value: containers.length, color: '#00d4ff' },
                { label: 'SLOTS', value: numCols * numRows, color: '#6b7a90' },
                { label: 'TIER MÁX', value: stats.maxHeight + 1, color: '#c084fc' },
                { label: 'VISÍVEIS', value: visibleCount, color: '#4ade80' },
              ].map((s, i) => (
                <div key={i} className="yard3d-stat">
                  <p style={{ fontSize: 18, fontWeight: 700, color: s.color, margin: 0, fontFamily: "'Syne', sans-serif" }}>{s.value}</p>
                  <p style={{ fontSize: 8, color: '#6b7a90', margin: '2px 0 0', letterSpacing: '0.1em' }}>{s.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Selected container detail */}
          {selectedContainer && statusDef && (
            <div style={{ padding: '12px 14px' }}>
              <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#6b7a90', margin: '0 0 10px', textTransform: 'uppercase' }}>Selecionado</p>
              <div style={{ background: '#151b23', border: `1px solid ${statusDef.border}44`, borderRadius: 6, padding: 12 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: statusDef.border, margin: '0 0 10px', fontFamily: "'Syne', sans-serif", letterSpacing: '0.05em' }}>
                  {selectedContainer.id}
                </p>
                {[
                  { k: 'Tipo', v: typeDef?.label ?? selectedContainer.type },
                  { k: 'Status', v: statusDef.label },
                  { k: 'Posição', v: selectedContainer.position },
                  { k: 'Altura', v: selectedContainer.height === 0 ? 'Piso' : `Nível ${selectedContainer.height}` },
                  ...(selectedContainer.armador ? [{ k: 'Armador', v: selectedContainer.armador }] : []),
                  ...(selectedContainer.notes ? [{ k: 'Obs.', v: selectedContainer.notes }] : []),
                ].map((row, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 10, color: '#6b7a90' }}>{row.k}</span>
                    <span style={{ fontSize: 10, color: '#e2e8f0', fontWeight: 500, maxWidth: '55%', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!selectedContainer && (
            <div style={{ padding: '14px', fontSize: 11, color: '#6b7a90', textAlign: 'center' }}>
              <Package size={24} style={{ margin: '8px auto', opacity: 0.3, display: 'block' }} />
              Clique em um container
            </div>
          )}
        </div>

        {/* ── Canvas ── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div ref={wrapRef} style={{ width: '100%', height: '100%' }} />

          {/* Loading overlay */}
          {!loaded && (
            <div style={{
              position: 'absolute', inset: 0, background: '#0a0c10',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 10,
            }}>
              <p style={{ fontSize: 12, letterSpacing: '0.2em', color: '#00d4ff', marginBottom: 16, fontFamily: "'Syne', sans-serif" }}>
                CARREGANDO PÁTIO...
              </p>
              <div style={{ width: 200, height: 2, background: '#1e2530', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: '#00d4ff', animation: 'yard3dLoad 0.8s ease forwards', borderRadius: 2 }} />
              </div>
              <style>{`@keyframes yard3dLoad { to { width: 100%; } }`}</style>
            </div>
          )}

          {/* HUD */}
          {loaded && (
            <>
              <div style={{
                position: 'absolute', top: 12, right: 12,
                fontSize: 9, color: '#6b7a90', textAlign: 'right', letterSpacing: '0.05em',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                <p style={{ margin: '0 0 3px' }}>{visibleCount} containers visíveis</p>
                <p style={{ margin: 0 }}>Scroll: zoom • Drag: orbitar</p>
              </div>

              {/* Legend */}
              <div style={{
                position: 'absolute', bottom: 16, right: 16,
                background: '#0f1318cc', border: '1px solid #1e2530',
                borderRadius: 6, padding: '10px 14px', backdropFilter: 'blur(4px)',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {containerStatuses.filter(s => (stats.byStatus[s.id] ?? 0) > 0).map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    <span style={{ width: 12, height: 8, borderRadius: 2, background: s.border, display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: '#6b7a90' }}>{s.label}</span>
                    <span style={{ fontSize: 10, color: s.text, marginLeft: 'auto', paddingLeft: 10 }}>{stats.byStatus[s.id]}</span>
                  </div>
                ))}
              </div>

              {/* Grid info */}
              <div style={{
                position: 'absolute', bottom: 16, left: 16,
                background: '#0f1318cc', border: '1px solid #1e2530',
                borderRadius: 6, padding: '8px 12px', backdropFilter: 'blur(4px)',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Map size={11} color="#00d4ff" />
                  <span style={{ fontSize: 10, color: '#6b7a90' }}>
                    {activeSpace?.name} · {numCols}×{numRows}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
