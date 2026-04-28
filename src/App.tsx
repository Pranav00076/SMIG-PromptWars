import React, { useState, useRef, useEffect } from 'react';
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { GoogleGenAI } from '@google/genai';
import {
  ShieldAlert, ShieldCheck, Upload, Image as ImageIcon,
  CheckCircle, AlertTriangle, X, Database, FileText, Copy, Activity, Clock, List, LogOut
} from 'lucide-react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut, User } from 'firebase/auth';
import { auth } from './lib/firebase';

interface Asset {
  id: string;
  filename: string;
  timestamp: number;
  imageStr: string;
  hash: string;
  txHash: string;
  watermarkId: string;
}

interface CheckResult {
  id: string;
  timestamp: number;
  suspectImageStr: string;
  suspectHash?: string;
  pHashSimilarity?: number;
  match: boolean;
  confidence: number;
  explanation: string;
  textOverlayDetected?: boolean;
  platform: string;
  sourceTrace: string;
  alertStatus: 'Safe' | 'High-Risk' | 'Low-Risk';
  originalAssetId: string;
}

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

const getCroppedImg = (image: HTMLImageElement, crop: Crop): Promise<string> => {
  const canvas = document.createElement('canvas');
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const pixelRatio = window.devicePixelRatio || 1;
  
  canvas.width = Math.floor(crop.width * scaleX * pixelRatio);
  canvas.height = Math.floor(crop.height * scaleY * pixelRatio);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return Promise.resolve('');
  }

  ctx.scale(pixelRatio, pixelRatio);
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    crop.width * scaleX,
    crop.height * scaleY,
    0,
    0,
    crop.width * scaleX,
    crop.height * scaleY
  );

  return new Promise((resolve) => {
    resolve(canvas.toDataURL('image/jpeg', 0.95));
  });
};

const getInlineData = (base64String: string) => {
  const match = base64String.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: 'image/jpeg', data: base64String };
};

const generateHash = (imageStr: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(Math.random().toString(16).substring(2, 18));
        
        // 1. Resize to 32x32
        ctx.drawImage(img, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size).data;
        
        // 2. Convert to grayscale (luminance)
        const vals = new Float32Array(size * size);
        for (let i = 0; i < vals.length; i++) {
          const r = imgData[i * 4];
          const g = imgData[i * 4 + 1];
          const b = imgData[i * 4 + 2];
          vals[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        }
        
        // 3. Compute top-left 8x8 DCT (Discrete Cosine Transform)
        const dctVals = new Float32Array(64);
        const C = Math.PI / (2 * size);
        let idx = 0;
        for (let v = 0; v < 8; v++) {
          for (let u = 0; u < 8; u++) {
            let sum = 0;
            for (let y = 0; y < size; y++) {
              for (let x = 0; x < size; x++) {
                sum += vals[y * size + x] * 
                       Math.cos((2 * x + 1) * u * C) * 
                       Math.cos((2 * y + 1) * v * C);
              }
            }
            dctVals[idx++] = sum;
          }
        }
        
        // 4. Calculate Median of the DCT coefficients (excluding DC component at index 0)
        const dctNoDc = Array.from(dctVals).slice(1);
        dctNoDc.sort((a, b) => a - b);
        const medianVal = dctNoDc[Math.floor(dctNoDc.length / 2)];
        
        // 5. Construct 64-bit binary hash
        let binaryStr = '';
        for (let i = 0; i < 64; i++) {
          binaryStr += dctVals[i] > medianVal ? '1' : '0';
        }
        
        // 6. Convert binary string to lowercase Hex
        let hexHash = '';
        for (let i = 0; i < 64; i += 4) {
          hexHash += parseInt(binaryStr.substring(i, i + 4), 2).toString(16);
        }
        
        resolve(hexHash);
      } catch (err) {
        resolve(Math.random().toString(16).substring(2, 18));
      }
    };
    img.onerror = () => resolve(Math.random().toString(16).substring(2, 18));
    img.src = imageStr;
  });
};

const calculateHammingDistance = (hash1: string, hash2: string): number => {
  if (hash1.length !== hash2.length) return 64;
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    const val1 = parseInt(hash1[i], 16);
    const val2 = parseInt(hash2[i], 16);
    const xor = val1 ^ val2;
    // count set bits in xor
    for (let b = 0; b < 4; b++) {
      if ((xor >> b) & 1) dist++;
    }
  }
  return dist;
};

const SAMPLE_ASSET_1: Asset = {
  id: 'sample-asset-1',
  filename: 'premier_league_feed_A.mp4_frame01.jpg',
  timestamp: Date.now() - 1000 * 60 * 60 * 24,
  imageStr: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" fill="#1e3a8a"><rect width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">PL Feed A</text></svg>'),
  hash: 'a1b2c3d4e5f60123',
  txHash: '0xabc123def456abc123def456abc123def456abc1',
  watermarkId: 'Broadcaster-Sky-UK-01',
};

const SAMPLE_ASSET_2: Asset = {
  id: 'sample-asset-2',
  filename: 'nba_finals_g7_cam3.jpg',
  timestamp: Date.now() - 1000 * 60 * 60 * 48,
  imageStr: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" fill="#991b1b"><rect width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">NBA Final C3</text></svg>'),
  hash: '9f8e7d6c5b4a3021',
  txHash: '0x999888777666555444333222111000fffcccbbb',
  watermarkId: 'League-Pass-Int-99',
};

const SAMPLE_CHECK_1: CheckResult = {
  id: 'sample-check-1',
  timestamp: Date.now() - 1000 * 60 * 30,
  suspectImageStr: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" fill="#1e3a8a"><rect width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">PL Feed A (Mirrored)</text></svg>'),
  match: true,
  confidence: 94,
  explanation: 'The images share identical subject matter and color distribution, matching the baseline despite minor artifacting.',
  platform: 'Unknown Streaming Site',
  sourceTrace: 'Broadcaster-Sky-UK-01',
  alertStatus: 'High-Risk',
  originalAssetId: 'sample-asset-1',
};

const SAMPLE_CHECK_2: CheckResult = {
  id: 'sample-check-2',
  timestamp: Date.now() - 1000 * 60 * 60 * 5,
  suspectImageStr: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" fill="#991b1b"><rect width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">NBA Highlights</text></svg>'),
  match: true,
  confidence: 98,
  explanation: 'An exact match of the core scene. Detected watermark confirms the source.',
  platform: 'Official Partner Site',
  sourceTrace: 'League-Pass-Int-99',
  alertStatus: 'Low-Risk',
  originalAssetId: 'sample-asset-2',
};

const SAMPLE_CHECK_3: CheckResult = {
  id: 'sample-check-3',
  timestamp: Date.now() - 1000 * 60 * 60 * 12,
  suspectImageStr: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" fill="#047857"><rect width="100%" height="100%"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">Fan Photo</text></svg>'),
  match: false,
  confidence: 12,
  explanation: 'Contents do not resemble the original asset. Likely an unrelated photo from the same event.',
  platform: 'Social Media',
  sourceTrace: '',
  alertStatus: 'Safe',
  originalAssetId: 'sample-asset-1',
};

const INIT_ASSETS = [SAMPLE_ASSET_1, SAMPLE_ASSET_2];
const INIT_CHECKS = [SAMPLE_CHECK_1, SAMPLE_CHECK_2, SAMPLE_CHECK_3];

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [assets, setAssets] = useState<Asset[]>(INIT_ASSETS);
  const [checks, setChecks] = useState<CheckResult[]>(INIT_CHECKS);
  
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      setCurrentUser(user);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch(err) {
      console.error(err);
    }
  };

  const [activeTab, setActiveTab] = useState<'detection' | 'dashboard'>('detection');
  const [activeAlert, setActiveAlert] = useState<CheckResult | null>(null);

  // Registration Form
  const [regFile, setRegFile] = useState<File | null>(null);
  const [regImageSrc, setRegImageSrc] = useState<string>('');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [regWatermark, setRegWatermark] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Detection Form
  const [selectedAssetId, setSelectedAssetId] = useState<string>(INIT_ASSETS[0].id);
  const [suspectFile, setSuspectFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState('Unknown Streaming Site');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [latestResult, setLatestResult] = useState<CheckResult | null>(null);
  const suspectInputRef = useRef<HTMLInputElement>(null);

  // Modal
  const [dmcaModal, setDmcaModal] = useState<CheckResult | null>(null);

  // Filters & Sorts
  const [filterStatus, setFilterStatus] = useState<string>('All');
  const [sortField, setSortField] = useState<'timestamp' | 'platform' | 'confidence'>('timestamp');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const [tasks, setTasks] = useState<{id: string, fileName: string, status: string}[]>([]);
  const [assetSearch, setAssetSearch] = useState('');

  const getFilteredAndSortedChecks = () => {
    let filtered = checks;
    if (filterStatus !== 'All') {
      filtered = filtered.filter(c => c.alertStatus === filterStatus);
    }
    
    // Create a copy to sort
    const sorted = [...filtered].sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];
      
      if (sortField === 'confidence' && !a.match) valA = -1;
      if (sortField === 'confidence' && !b.match) valB = -1;
      
      if (valA < valB) return sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    
    return sorted;
  };

  const processedChecks = getFilteredAndSortedChecks();

  const filteredAssets = assets.filter(a => 
    a.filename.toLowerCase().includes(assetSearch.toLowerCase()) || 
    a.watermarkId.toLowerCase().includes(assetSearch.toLowerCase())
  );

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regFile || !regImageSrc) return;
    setIsRegistering(true);

    try {
      let b64 = regImageSrc;
      if (completedCrop && imgRef.current && completedCrop.width > 0 && completedCrop.height > 0) {
        b64 = await getCroppedImg(imgRef.current, completedCrop);
      }
      
      const hash = await generateHash(b64);
      
      const newAsset: Asset = {
        id: Math.random().toString(36).substring(2, 9),
        filename: regFile.name,
        timestamp: Date.now(),
        imageStr: b64,
        hash,
        txHash: '0x' + Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join(''),
        watermarkId: regWatermark || 'None'
      };

      setAssets([newAsset, ...assets]);
      if (!selectedAssetId) setSelectedAssetId(newAsset.id);
      
      // Reset form
      setRegFile(null);
      setRegImageSrc('');
      setRegWatermark('');
      setCrop(undefined);
      setCompletedCrop(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error(err);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspectFile || !selectedAssetId) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setDetectError("Gemini API Key is missing. Please configure it in AI Studio settings.");
      return;
    }

    setDetectError('');

    const taskId = Math.random().toString(36).substring(2, 9);
    const taskFileName = suspectFile.name;
    const fileToProcess = suspectFile;
    const platformToProcess = platform;
    const originalAssetIdToProcess = selectedAssetId;

    setTasks(prev => [{ id: taskId, fileName: taskFileName, status: 'Processing...' }, ...prev]);
    setSuspectFile(null);
    if (suspectInputRef.current) suspectInputRef.current.value = '';

    try {
      const original = assets.find(a => a.id === originalAssetIdToProcess);
      if (!original) throw new Error("Original asset not found");

      const suspectB64 = await fileToBase64(fileToProcess);
      const originalData = getInlineData(original.imageStr);
      const suspectData = getInlineData(suspectB64);

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `You are an expert copyright infringement detection system. Compare these two images. Are they essentially the same content, possibly modified by resizing, cropping, color filtering, compression artifacts, or text overlay?
Pay special attention to ANY text overlays or watermarks on the second (suspect) image that are not present in the first. Analyze the text to see if it obscures the underlying content or adds custom branding.
Reply EXCLUSIVELY with a JSON object containing the following keys (no markdown formatting, just raw JSON):
"match": boolean true if the underlying visual content is substantially the same (even if obscured by text), false otherwise.
"confidence": integer between 0 and 100 representing your confidence in the match.
"textOverlayDetected": boolean true if the suspect image contains added text overlays or watermarks, false otherwise.
"explanation": a short explanation of your reasoning, specifically mentioning if any text overlays were detected (and what they say, if readable) and whether they obscure the core content.`;

      // Compute suspect hash & distance locally while AI analyzes
      const suspectHash = await generateHash(suspectB64);
      const hammingDist = calculateHammingDistance(original.hash, suspectHash);
      const pHashSimilarity = Math.max(0, 100 - Math.round((hammingDist / 64) * 100));

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [
          prompt,
          { inlineData: { data: originalData.data, mimeType: originalData.mimeType } },
          { inlineData: { data: suspectData.data, mimeType: suspectData.mimeType } }
        ],
        config: {
          responseMimeType: 'application/json'
        }
      });

      const text = response.text || "{}";
      const resultData = JSON.parse(text);

      let alertStatus: 'Safe' | 'High-Risk' | 'Low-Risk' = 'Safe';
      if (resultData.match) {
        if (platform !== 'Official Partner Site') {
          alertStatus = 'High-Risk';
        } else {
          alertStatus = 'Low-Risk';
        }
      }

      const newCheck: CheckResult = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: Date.now(),
        suspectImageStr: suspectB64,
        suspectHash,
        pHashSimilarity,
        match: resultData.match,
        confidence: resultData.confidence || 0,
        explanation: resultData.explanation || 'No explanation provided.',
        textOverlayDetected: !!resultData.textOverlayDetected,
        platform: platformToProcess,
        sourceTrace: resultData.match ? original.watermarkId : '',
        alertStatus,
        originalAssetId: original.id
      };

      setChecks([newCheck, ...checks]);
      setLatestResult(newCheck);
      
      if (alertStatus === 'High-Risk') {
        setActiveAlert(newCheck);
      }
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'Completed' } : t));
    } catch (err: any) {
      console.error(err);
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'Failed' } : t));
      setDetectError(err.message || 'Analysis failed. Make sure your API key is valid.');
    }
  };

  const currentOriginal = assets.find(a => a.id === selectedAssetId);

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <Activity className="animate-spin text-blue-500" size={32} />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="flex h-screen bg-slate-50 font-sans text-slate-800 items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 w-full max-w-md">
          <div className="flex justify-center mb-6">
            <div className="bg-slate-900 p-3 rounded-full inline-block">
              <ShieldAlert className="text-blue-400" size={32} />
            </div>
          </div>
          <h1 className="text-2xl justify-center font-bold text-center text-slate-800 mb-2">SMIG Grid</h1>
          <p className="text-sm text-center text-slate-500 mb-6">Media Integrity Dashboard Authentication</p>
          
          <form onSubmit={handleAuth} className="space-y-4">
            {authError && <div className="p-3 bg-red-100 text-red-700 text-sm rounded border border-red-200">{authError}</div>}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"/>
            </div>
            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded-md transition-colors flex items-center justify-center">
              {isLogin ? 'Sign In' : 'Sign Up'}
            </button>
          </form>
          <div className="mt-4 text-center">
            <button type="button" onClick={() => {setIsLogin(!isLogin); setAuthError('');}} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden text-slate-800">
      
      {/* LEFT SIDEBAR: Registration */}
      <div className="w-[400px] border-r border-slate-200 bg-white shadow-sm flex flex-col z-10 shrink-0">
        <div className="p-6 bg-slate-900 text-white flex items-center gap-3 shrink-0">
          <ShieldAlert className="text-blue-400" size={28} />
          <div>
            <h1 className="font-bold text-lg leading-tight">SMIG Grid</h1>
            <p className="text-xs text-slate-400">Media Integrity Dashboard</p>
          </div>
        </div>

        <div className="p-6 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Database size={18} /> Register Original Asset
          </h2>
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Upload Source Image</label>
              <input 
                type="file" 
                accept="image/*"
                ref={fileInputRef}
                onChange={async e => {
                  const file = e.target.files?.[0] || null;
                  setRegFile(file);
                  if (file) {
                    const src = await fileToBase64(file);
                    setRegImageSrc(src);
                  } else {
                    setRegImageSrc('');
                  }
                }}
                className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer border border-slate-200 rounded-md p-1"
                required
              />
            </div>
            {regImageSrc && (
               <div className="bg-slate-50 rounded border border-slate-100 flex flex-col items-center justify-center overflow-hidden">
                 <div className="w-full bg-slate-100 px-2 py-1 border-b border-slate-200 text-xs text-slate-500 font-medium text-center">
                    Drag to crop / resize before registering
                 </div>
                 <div className="p-2 w-full flex justify-center">
                   <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)}>
                     <img ref={imgRef} src={regImageSrc} alt="Crop Preview" className="max-h-64 object-contain" />
                   </ReactCrop>
                 </div>
               </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Forensic Watermark ID (Optional)</label>
              <input 
                type="text" 
                placeholder="e.g. Broadcaster-Feed-3"
                value={regWatermark}
                onChange={e => setRegWatermark(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button 
              type="submit" 
              disabled={!regFile || isRegistering}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded-md transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isRegistering ? <Activity className="animate-spin" size={18} /> : <Upload size={18} />}
              {isRegistering ? 'Registering...' : 'Register Asset'}
            </button>
          </form>
        </div>

        <div className="flex-1 min-h-0 flex flex-col p-6 bg-slate-50">
          <div className="shrink-0 mb-4">
            <h2 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
              <List size={18} /> Registered Assets ({assets.length})
            </h2>
            <input
              type="text"
              placeholder="Search filename or ID..."
              value={assetSearch}
              onChange={(e) => setAssetSearch(e.target.value)}
              className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
            />
          </div>
          {filteredAssets.length === 0 ? (
            <div className="text-center text-sm text-slate-400 py-8">
              No assets match your search.
            </div>
          ) : (
            <div className="space-y-4 overflow-y-auto flex-1 pr-1 pb-4">
              {filteredAssets.map(asset => (
                <div key={asset.id} className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm flex gap-3 cursor-pointer hover:border-blue-300 transition-colors" onClick={() => setSelectedAssetId(asset.id)}>
                  <div className="w-16 h-16 shrink-0 bg-slate-100 rounded overflow-hidden">
                    <img src={asset.imageStr} alt={asset.filename} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <p className="text-sm font-medium text-slate-800 truncate" title={asset.filename}>{asset.filename}</p>
                    <p className="text-xs text-slate-500 font-mono truncate" title={asset.txHash}>TX: {asset.txHash}</p>
                    {asset.watermarkId && asset.watermarkId !== 'None' && (
                      <p className="text-xs text-blue-600 mt-1 flex gap-1 items-center">
                        <ImageIcon size={12}/> ID: {asset.watermarkId}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        
        {/* Global Alert Banner */}
        {activeAlert && (
          <div className="absolute top-0 left-0 right-0 bg-red-600 text-white px-6 py-4 flex items-center justify-between shadow-lg z-50 animate-in slide-in-from-top-10">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-red-500 rounded-full animate-pulse">
                <AlertTriangle size={24} />
              </div>
              <div>
                <h3 className="font-bold text-lg">High-Risk Unauthorized Copy Detected!</h3>
                <p className="text-red-100 text-sm">
                  Match Confidence: {activeAlert.confidence}%. 
                  Source Traced: <span className="font-mono font-bold bg-red-700 px-1 rounded">{activeAlert.sourceTrace || 'Unknown'}</span>
                </p>
              </div>
            </div>
            <button onClick={() => setActiveAlert(null)} className="text-red-200 hover:text-white p-2">
              <X size={24} />
            </button>
          </div>
        )}

        {/* Tab Nav */}
        <div className="bg-white border-b border-slate-200 px-8 flex gap-8 shrink-0">
          <button 
            className={`py-4 font-medium text-sm border-b-2 transition-colors ${activeTab === 'detection' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            onClick={() => setActiveTab('detection')}
          >
            Detection Check
          </button>
          <button 
            className={`py-4 font-medium text-sm border-b-2 transition-colors ${activeTab === 'dashboard' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Live Dashboard
          </button>
          
          <div className="flex-1 flex items-center justify-end px-4 gap-4">
            {tasks.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Activity size={16} className={tasks.some(t => t.status === 'Processing...') ? 'animate-spin' : ''} />
                <span className="font-medium">{tasks.filter(t => t.status === 'Processing...').length} Active Tasks</span>
              </div>
            )}
            <div className="text-sm border-l border-slate-200 pl-4 py-2 flex items-center gap-3">
              <span className="text-slate-500 hidden sm:inline-block">{currentUser.email}</span>
              <button onClick={handleLogout} className="text-slate-500 hover:text-red-600 font-medium flex items-center gap-1 transition-colors" title="Sign Out">
                <LogOut size={16} /> 
              </button>
            </div>
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-8">
          
          {/* DETECTION TAB */}
          {activeTab === 'detection' && (
            <div className="max-w-5xl mx-auto">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="border-b border-slate-100 p-6 bg-slate-50 flex justify-between items-center">
                  <h2 className="text-lg font-semibold text-slate-800">Analyze Suspect Media</h2>
                  {!process.env.GEMINI_API_KEY && (
                    <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded font-medium border border-red-200">
                      API Key Missing
                    </span>
                  )}
                </div>
                
                <div className="p-6">
                  {assets.length === 0 ? (
                    <div className="text-center py-12 px-4 bg-yellow-50 text-yellow-800 rounded-lg border border-yellow-200">
                      <AlertTriangle className="mx-auto mb-3" size={32} />
                      <p className="font-medium">No original assets registered.</p>
                      <p className="text-sm mt-1">Please register an original asset in the sidebar first to perform detection.</p>
                    </div>
                  ) : (
                    <form onSubmit={handleAnalyze} className="space-y-6">
                      <div className="grid grid-cols-2 gap-8">
                        
                        {/* Source Select */}
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">Original Baseline Asset</label>
                          <select 
                            value={selectedAssetId}
                            onChange={e => setSelectedAssetId(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {assets.map(a => <option key={a.id} value={a.id}>{a.filename}</option>)}
                          </select>
                          
                          {currentOriginal && (
                             <div className="mt-4 border border-slate-200 rounded-lg overflow-hidden bg-slate-100 h-48 flex items-center justify-center relative group">
                               <img src={currentOriginal.imageStr} className="max-h-full object-contain" alt="Original" />
                               <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-xs p-2 truncate">
                                 {currentOriginal.filename}
                               </div>
                             </div>
                          )}
                        </div>

                        {/* Suspect Upload */}
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">Suspect Media Image</label>
                          <input 
                            type="file" 
                            accept="image/*"
                            ref={suspectInputRef}
                            onChange={e => setSuspectFile(e.target.files?.[0] || null)}
                            className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer border border-slate-300 rounded-lg p-1"
                            required
                          />

                          {suspectFile ? (
                             <div className="mt-4 border border-rose-200 rounded-lg overflow-hidden bg-rose-50 h-48 flex items-center justify-center relative">
                               <img src={URL.createObjectURL(suspectFile)} className="max-h-full object-contain" alt="Suspect" />
                             </div>
                          ) : (
                            <div className="mt-4 border-2 border-dashed border-slate-200 rounded-lg h-48 flex flex-col items-center justify-center text-slate-400 bg-slate-50">
                               <ImageIcon size={32} className="mb-2 opacity-50" />
                               <span className="text-sm">Upload suspect image to compare</span>
                            </div>
                          )}
                        </div>

                      </div>

                      <div className="bg-slate-50 p-4 border border-slate-200 rounded-lg flex items-end gap-6 justify-between">
                         <div className="flex-1 max-w-sm">
                           <label className="block text-sm font-medium text-slate-700 mb-2">Platform / Source</label>
                           <select 
                             value={platform}
                             onChange={e => setPlatform(e.target.value)}
                             className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                           >
                             <option value="Official Partner Site">Official Partner Site</option>
                             <option value="Social Media">Social Media (X, Facebook, etc.)</option>
                             <option value="Unknown Streaming Site">Unknown Streaming Site</option>
                             <option value="Messaging App">Messaging App (Telegram, WhatsApp)</option>
                           </select>
                         </div>
                         
                         <button 
                            type="submit" 
                            disabled={!suspectFile}
                            className="px-6 py-2 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 h-[38px] w-48 justify-center"
                          >
                            <ShieldCheck size={18} />
                            Queue Analysis
                          </button>
                      </div>

                      {detectError && (
                        <div className="p-4 bg-red-50 text-red-700 rounded-lg border border-red-200 text-sm">
                          {detectError}
                        </div>
                      )}
                    </form>
                  )}
                </div>
              </div>

              {/* TASK QUEUE & LATEST RESULT */}
              {tasks.length > 0 && (
                <div className="mt-8 rounded-xl shadow-sm border border-slate-200 overflow-hidden bg-white">
                  <div className="bg-slate-50 border-b border-slate-200 p-4 font-semibold text-slate-700 flex items-center gap-2">
                    <Activity size={18} />
                    Analysis Task Queue
                  </div>
                  <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                    {tasks.map(task => (
                      <div key={task.id} className="p-3 px-6 flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3">
                          {task.status === 'Processing...' ? (
                            <Activity size={16} className="text-blue-500 animate-spin" />
                          ) : task.status === 'Completed' ? (
                            <CheckCircle size={16} className="text-green-500" />
                          ) : (
                            <AlertTriangle size={16} className="text-red-500" />
                          )}
                          <span className="font-medium text-slate-800">{task.fileName}</span>
                        </div>
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                          task.status === 'Processing...' ? 'bg-blue-100 text-blue-700' :
                          task.status === 'Completed' ? 'bg-green-100 text-green-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {task.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {latestResult && (
                <div className={`mt-8 rounded-xl shadow-sm border overflow-hidden ${latestResult.alertStatus === 'High-Risk' ? 'border-red-300' : latestResult.alertStatus === 'Low-Risk' ? 'border-green-300' : 'border-slate-200'}`}>
                  <div className={`p-4 font-semibold flex items-center justify-between ${
                    latestResult.alertStatus === 'High-Risk' ? 'bg-red-50 text-red-900' : 
                    latestResult.alertStatus === 'Low-Risk' ? 'bg-green-50 text-green-900' : 
                    'bg-slate-50 text-slate-800'
                  }`}>
                    <div className="flex items-center gap-2">
                       {latestResult.match ? (latestResult.alertStatus === 'High-Risk' ? <ShieldAlert className="text-red-600"/> : <CheckCircle className="text-green-600"/>) : <Clock className="text-slate-500"/>}
                       AI Analysis Verdict
                    </div>
                    {latestResult.match && <span className="text-lg">Match Confidence: {latestResult.confidence}%</span>}
                  </div>
                  
                  <div className="bg-white p-6 grid grid-cols-[1fr_2fr] gap-8">
                     <div className="space-y-4 text-sm">
                        <div className="border-b pb-2">
                          <span className="text-slate-500 block text-xs">AI Match Result</span>
                          <span className={`font-bold text-lg ${latestResult.match ? 'text-red-600' : 'text-green-600'}`}>
                            {latestResult.match ? 'YES - Media Matched' : 'NO - Distinct Content'}
                          </span>
                        </div>
                        {latestResult.pHashSimilarity !== undefined && (
                          <div className="border-b pb-2 flex items-center justify-between">
                            <div>
                              <span className="text-slate-500 block text-xs">pHash Pre-Check Similarity</span>
                              <span className="font-medium text-slate-800">{latestResult.pHashSimilarity}%</span>
                            </div>
                            <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
                              <div className={`h-full ${latestResult.pHashSimilarity > 80 ? 'bg-red-500' : latestResult.pHashSimilarity > 60 ? 'bg-orange-400' : 'bg-green-500'}`} style={{ width: `${latestResult.pHashSimilarity}%` }} />
                            </div>
                          </div>
                        )}
                        {latestResult.textOverlayDetected && (
                          <div className="border-b pb-2">
                            <span className="text-slate-500 block text-xs">Text Overlay/Watermark</span>
                            <span className="font-medium text-orange-600 flex items-center gap-1">
                              <AlertTriangle size={14} /> Detected
                            </span>
                          </div>
                        )}
                        <div className="border-b pb-2">
                          <span className="text-slate-500 block text-xs">Suspect Platform</span>
                          <span className="font-medium text-slate-800">{latestResult.platform}</span>
                        </div>
                        {latestResult.match && latestResult.sourceTrace && (
                          <div className="border-b pb-2">
                            <span className="text-slate-500 block text-xs">Forensic Source Traced</span>
                            <span className="font-mono font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded">{latestResult.sourceTrace}</span>
                          </div>
                        )}
                        <div>
                          <span className="text-slate-500 block text-xs">Alert Status</span>
                          <span className={`inline-block px-2 py-1 rounded text-xs font-bold mt-1 ${
                            latestResult.alertStatus === 'High-Risk' ? 'bg-red-100 text-red-800' : 
                            latestResult.alertStatus === 'Low-Risk' ? 'bg-green-100 text-green-800' : 
                            'bg-slate-100 text-slate-700'
                          }`}>
                            {latestResult.alertStatus.toUpperCase()}
                          </span>
                        </div>
                     </div>
                     <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                        <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">AI Explanation</h4>
                        <p className="text-slate-700 leading-relaxed">
                          "{latestResult.explanation}"
                        </p>
                        
                        {latestResult.alertStatus === 'High-Risk' && (
                          <div className="mt-6 pt-4 border-t border-slate-200">
                             <h4 className="text-xs font-semibold text-red-700 uppercase mb-2 flex items-center gap-1"><FileText size={14}/> Live Takedown Notice Board</h4>
                             <textarea 
                               readOnly 
                               className="w-full h-48 p-3 font-mono text-xs border border-red-200 rounded text-slate-700 focus:outline-none resize-none bg-red-100 shadow-inner"
                               value={`NOTICE OF COPYRIGHT INFRINGEMENT

To Whom It May Concern,

I am authorized to act on behalf of the owner of the exclusive copyright for the associated media asset. We have detected an unauthorized copy of our registered material operating on your platform.

Infringing Material Location: ${latestResult.platform}
Date of Detection: ${new Date(latestResult.timestamp).toUTCString()}

Forensic Data Match:
- Blockchain Hash Ref: ${assets.find(a => a.id === latestResult.originalAssetId)?.txHash || 'UNKNOWN'}
- Original Source Trace ID: ${latestResult.sourceTrace}
- AI Match Confidence: ${latestResult.confidence}%
${latestResult.pHashSimilarity !== undefined ? `- pHash Pre-Check Similarity: ${latestResult.pHashSimilarity}%\n` : ''}
Please act expeditiously to remove or disable access to the material.

Signed,
[Your Name / Agent]
Sports Media Integrity Grid Security Engine`}
                             />
                             <div className="mt-2 text-right">
                               <button 
                                 onClick={() => {
                                   const text = `NOTICE OF COPYRIGHT INFRINGEMENT\n\nTo Whom It May Concern,\n\nI am authorized to act on behalf of the owner of the exclusive copyright for the associated media asset. We have detected an unauthorized copy of our registered material operating on your platform.\n\nInfringing Material Location: ${latestResult.platform}\nDate of Detection: ${new Date(latestResult.timestamp).toUTCString()}\n\nForensic Data Match:\n- Blockchain Hash Ref: ${assets.find(a => a.id === latestResult.originalAssetId)?.txHash || 'UNKNOWN'}\n- Original Source Trace ID: ${latestResult.sourceTrace}\n- AI Match Confidence: ${latestResult.confidence}%\n${latestResult.pHashSimilarity !== undefined ? `- pHash Pre-Check Similarity: ${latestResult.pHashSimilarity}%\n` : ''}\nPlease act expeditiously to remove or disable access to the material.\n\nSigned,\n[Your Name / Agent]\nSports Media Integrity Grid Security Engine`;
                                   navigator.clipboard.writeText(text);
                                   alert('Copied to clipboard!');
                                 }}
                                 className="px-3 py-1.5 font-medium text-white bg-red-600 hover:bg-red-700 rounded text-sm transition-colors flex items-center gap-2 ml-auto shadow-sm"
                               >
                                 <Copy size={14} /> Copy to Clipboard
                               </button>
                             </div>
                          </div>
                        )}
                     </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* DASHBOARD TAB */}
          {activeTab === 'dashboard' && (
            <div className="max-w-6xl mx-auto space-y-8">
              
              <div className="grid grid-cols-3 gap-6">
                 <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                      <Database size={24} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">Registered Assets</p>
                      <p className="text-3xl font-bold text-slate-800">{assets.length}</p>
                    </div>
                 </div>
                 
                 <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center">
                      <Activity size={24} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">Detections Run</p>
                      <p className="text-3xl font-bold text-slate-800">{checks.length}</p>
                    </div>
                 </div>
                 
                 <div className="bg-white border border-red-200 rounded-xl p-6 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                      <ShieldAlert size={24} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">High-Risk Alerts</p>
                      <p className="text-3xl font-bold text-red-600">
                        {checks.filter(c => c.alertStatus === 'High-Risk').length}
                      </p>
                    </div>
                 </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <h3 className="font-bold text-slate-700">Recent Checks Log</h3>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Filter:</span>
                      <select 
                        value={filterStatus}
                        onChange={e => setFilterStatus(e.target.value)}
                         className="border border-slate-300 rounded text-sm px-2 py-1 outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="All">All Statuses</option>
                        <option value="High-Risk">High-Risk</option>
                        <option value="Low-Risk">Low-Risk</option>
                        <option value="Safe">Safe</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2 border-l border-slate-200 pl-4">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sort:</span>
                      <select 
                        value={sortField}
                        onChange={e => setSortField(e.target.value as any)}
                        className="border border-slate-300 rounded-l text-sm px-2 py-1 outline-none bg-white focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="timestamp">Time</option>
                        <option value="confidence">Confidence</option>
                        <option value="platform">Platform</option>
                      </select>
                      <button 
                        onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')} 
                        className="text-slate-600 bg-white border border-l-0 border-slate-300 rounded-r px-2 py-1 text-sm hover:bg-slate-50 font-bold"
                        title="Toggle sort direction"
                      >
                        {sortDir === 'desc' ? '↓' : '↑'}
                      </button>
                    </div>
                  </div>
                </div>
                
                {processedChecks.length === 0 ? (
                  <div className="p-8 text-center text-slate-500">No detection logs match your criteria.</div>
                ) : (
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-medium">Time</th>
                        <th className="px-6 py-3 font-medium">Suspect</th>
                        <th className="px-6 py-3 font-medium">Verdict</th>
                        <th className="px-6 py-3 font-medium">Platform</th>
                        <th className="px-6 py-3 font-medium">Status & Source</th>
                        <th className="px-6 py-3 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {processedChecks.map(c => (
                        <tr key={c.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-3 text-slate-600">
                            {new Date(c.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="px-6 py-3">
                            <div className="w-8 h-8 rounded overflow-hidden bg-slate-100 inline-block border border-slate-200 align-middle shadow-sm">
                              <img src={c.suspectImageStr} className="w-full h-full object-cover" alt="suspect" />
                            </div>
                          </td>
                          <td className="px-6 py-3">
                             {c.match ? (
                               <span className="flex items-center gap-1 font-semibold text-red-600">
                                 {c.confidence}% Match
                               </span>
                             ) : (
                               <span className="text-green-600 font-medium">No Match</span>
                             )}
                          </td>
                          <td className="px-6 py-3 text-slate-700">{c.platform}</td>
                          <td className="px-6 py-3">
                             <div className="flex flex-col gap-1 items-start">
                               <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                 c.alertStatus === 'High-Risk' ? 'bg-red-100 text-red-700 border border-red-200' :
                                 c.alertStatus === 'Low-Risk' ? 'bg-orange-100 text-orange-700 border border-orange-200' :
                                 'bg-green-100 text-green-700 border border-green-200'
                               }`}>
                                 {c.alertStatus}
                               </span>
                               {c.sourceTrace && (
                                 <span className="font-mono text-xs text-slate-500" title="Source Trace">↳ {c.sourceTrace}</span>
                               )}
                             </div>
                          </td>
                          <td className="px-6 py-3 text-right">
                             {c.alertStatus === 'High-Risk' && (
                               <button 
                                 onClick={() => setDmcaModal(c)}
                                 className="text-xs font-semibold bg-red-600 text-white hover:bg-red-700 px-3 py-1.5 rounded transition-colors shadow-sm"
                               >
                                 Takedown
                               </button>
                             )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

            </div>
          )}

        </div>
      </div>

      {/* DMCA Modal Overlay */}
      {dmcaModal && (
        <div className="fixed inset-0 bg-slate-900/50 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden animate-in zoom-in-95">
             <div className="p-4 border-b flex items-center justify-between bg-slate-50">
               <h3 className="font-bold text-slate-800 flex items-center gap-2">
                 <FileText size={18} className="text-slate-500" />
                 Generated Takedown Notice
               </h3>
               <button onClick={() => setDmcaModal(null)} className="text-slate-400 hover:text-slate-700 p-1">
                 <X size={20} />
               </button>
             </div>
             
             <div className="p-6 flex-1 overflow-auto bg-slate-50/50">
               <textarea 
                 readOnly 
                 className="w-full h-80 p-4 font-mono text-sm border border-slate-300 rounded text-slate-700 focus:outline-none resize-none bg-white shadow-inner"
                 value={`NOTICE OF COPYRIGHT INFRINGEMENT

To Whom It May Concern,

I am authorized to act on behalf of the owner of the exclusive copyright for the associated media asset. We have detected an unauthorized copy of our registered material operating on your platform.

Infringing Material Location: ${dmcaModal.platform}
Date of Detection: ${new Date(dmcaModal.timestamp).toUTCString()}

Forensic Data Match:
- Blockchain Hash Ref: ${assets.find(a => a.id === dmcaModal.originalAssetId)?.txHash || 'UNKNOWN'}
- Original Source Trace ID: ${dmcaModal.sourceTrace}
- AI Match Confidence: ${dmcaModal.confidence}%

Under penalty of perjury, I state that the information in this notification is accurate and that I am the copyright owner or am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.

Please act expeditiously to remove or disable access to the material.

Signed,
[Your Name / Agent]
Sports Media Integrity Grid Security Engine
`}
               />
             </div>
             
             <div className="p-4 border-t bg-white flex justify-end gap-3">
               <button 
                 onClick={() => setDmcaModal(null)}
                 className="px-4 py-2 font-medium text-slate-600 hover:bg-slate-100 rounded transition-colors"
               >
                 Cancel
               </button>
               <button 
                 onClick={() => {
                   navigator.clipboard.writeText(document.querySelector('textarea')?.value || '');
                   alert('Copied to clipboard!');
                 }}
                 className="px-4 py-2 font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors flex items-center gap-2"
               >
                 <Copy size={16} /> Copy to Clipboard
               </button>
             </div>
          </div>
        </div>
      )}

    </div>
  );
}
