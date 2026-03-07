import {useEffect,useState,useRef,useMemo} from "react";
import {auth} from "./firebase";
import Login from "./Login";
import {onAuthStateChanged,signOut} from "firebase/auth";
import {collection,addDoc,getDocs,query,where,Timestamp,updateDoc,doc,deleteDoc} from "firebase/firestore";
import {db,functions} from "./firebase";
import {httpsCallable} from "firebase/functions";
import {CameraScanner} from "./components/CameraScanner";
import {VoiceEngine} from "./voice/voiceEngine";
import {initUserContext} from "./modules/userContext";

type DeliveryStatus="concluida"|"nao_realizada";
type Delivery={id:string;createdAt?:any;name?:string;street?:string;district?:string;city?:string;state?:string;postalCode?:string;country?:string;phone?:string;latitude?:number|null;longitude?:number|null;status:DeliveryStatus};

export default function App(){

const [user,setUser]=useState<any>(null);
const [all,setAll]=useState<Delivery[]>([]);
const [view,setView]=useState<"pendentes"|"concluidas">("pendentes");
const [mode,setMode]=useState<"operacao"|"historico"|"proxima">("operacao");
const [routeList,setRouteList]=useState<Delivery[]|null>(null);
const [loading,setLoading]=useState(true);
const [isScannerOpen,setIsScannerOpen]=useState(false);
const [preview,setPreview]=useState<any>(null);
const [offline,setOffline]=useState(!navigator.onLine);
const [expanded,setExpanded]=useState<string|null>(null);
const [pos,setPos]=useState<{lat:number;lon:number}|null>(null);
const voiceRef=useRef<VoiceEngine|null>(null);

useEffect(()=>{if(!navigator.geolocation)return;const id=navigator.geolocation.watchPosition(p=>setPos({lat:p.coords.latitude,lon:p.coords.longitude}));return()=>navigator.geolocation.clearWatch(id);},[]);
useEffect(()=>{const on=()=>{setOffline(false);syncQueue()};const off=()=>setOffline(true);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off)}},[]);
function queueAction(a:any){const q=JSON.parse(localStorage.getItem("lf_queue")||"[]");q.push(a);localStorage.setItem("lf_queue",JSON.stringify(q));}
async function syncQueue(){if(!navigator.onLine)return;const q=JSON.parse(localStorage.getItem("lf_queue")||"[]");for(const a of q){try{if(a.type==="update")await updateDoc(doc(db,"deliveries",a.id),a.data);if(a.type==="delete")await deleteDoc(doc(db,"deliveries",a.id));}catch{}}localStorage.removeItem("lf_queue");user&&load(user.uid);}

useEffect(()=>{if(!voiceRef.current)voiceRef.current=new VoiceEngine()},[]);
useEffect(()=>{const u=onAuthStateChanged(auth,async x=>{if(x){setUser(x);await initUserContext(x.uid)}else setUser(null);setLoading(false)});return()=>u()},[]);
useEffect(()=>{if(user)load(user.uid)},[user]);

async function load(uid:string){const q=query(collection(db,"deliveries"),where("userId","==",uid));const snap=await getDocs(q);setAll(snap.docs.map(d=>({id:d.id,...(d.data() as any)})));}

const pendentes=useMemo(()=>all.filter(d=>d.status==="nao_realizada"),[all]);
const concluidas=useMemo(()=>all.filter(d=>d.status==="concluida"),[all]);

function handleRoute(){
if(!navigator.geolocation)return;
navigator.geolocation.getCurrentPosition(p=>{
const {latitude,longitude}=p.coords;
const sorted=[...pendentes].filter(d=>d.latitude&&d.longitude)
.sort((a,b)=>((a.latitude!-latitude)**2+(a.longitude!-longitude)**2)-((b.latitude!-latitude)**2+(b.longitude!-longitude)**2));
setRouteList(sorted.length?sorted:null);
});
}

function aCaminho(d:Delivery){
if(!pos||!d.phone)return;
const msg=`Estou a caminho da entrega: ${d.street||""}, ${d.city||""}\nhttps://maps.google.com/?q=${pos.lat},${pos.lon}`;
window.open(`https://wa.me/${d.phone}?text=${encodeURIComponent(msg)}`,"_blank");
}

function handleVoice(){
voiceRef.current?.start((txt:string)=>{
const t=txt.toLowerCase();
if(t.includes("quantas")||t.includes("faltam")){
voiceRef.current?.speak(`Você tem ${pendentes.length} entregas pendentes`);
return;
}
if(t.includes("proxima")||t.includes("próxima")){
const n=(routeList||pendentes)[0];
if(!n){voiceRef.current?.speak("Não há entregas pendentes");return;}
voiceRef.current?.speak(`Próxima entrega: ${n.name||"Destinatário"}, ${n.street||""}, ${n.city||""}`);
return;
}
voiceRef.current?.speak("Comando não reconhecido");
});
}

async function concluir(id:string){await updateDoc(doc(db,"deliveries",id),{status:"concluida"});user&&load(user.uid);}
async function apagar(id:string){await deleteDoc(doc(db,"deliveries",id));user&&load(user.uid);}
async function apagarTodas(){for(const d of(view==="pendentes"?pendentes:concluidas))await apagar(d.id);}

async function tirarProva(id:string){const input=document.createElement("input");input.type="file";input.accept="image/*";input.capture="environment";input.onchange=async()=>{const file=input.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=async()=>{await updateDoc(doc(db,"deliveries",id),{proofImage:reader.result});};reader.readAsDataURL(file);};input.click();}

async function save(data:any){if(!user)return;const geo=httpsCallable(functions,"geocodeAddress");const g:any=await geo(data);await addDoc(collection(db,"deliveries"),{...data,userId:user.uid,latitude:g.data.latitude||null,longitude:g.data.longitude||null,status:"nao_realizada",createdAt:Timestamp.now()});setPreview(null);load(user.uid);}

if(loading)return<div style={{padding:30}}>Loading...</div>;
if(!user)return<Login/>;

const baseLista=view==="pendentes"?(routeList||pendentes):concluidas;
const lista=mode==="proxima"?pendentes.slice(0,1):mode==="historico"?concluidas:baseLista;

return(
<div style={app}>
<div style={header}>
<h1>🚚 LogiFlow</h1>

{offline&&<div style={offlineBar}>⚠️ Sem internet — modo offline</div>}

<div style={grid2}>
<button style={btn("#4b5563")} onClick={()=>signOut(auth)}>🚪 Sair</button>
<button style={btn("#2563eb")} onClick={()=>setIsScannerOpen(true)}>📸 Escanear</button>
<button style={btn("#059669")} onClick={handleVoice}>🎤 Falar</button>
<button style={btn("#047857")} onClick={handleRoute}>🗺️ Rota</button>
</div>

<div style={grid3}>
<button style={view==="pendentes"?btn("#2563eb"):btn("#e5e7eb","#111")} onClick={()=>{setMode("operacao");setView("pendentes");setRouteList(null);}}>Pendentes</button>
<button style={view==="concluidas"?btn("#7c3aed"):btn("#e5e7eb","#111")} onClick={()=>{setMode("operacao");setView("concluidas");setRouteList(null);}}>Concluídas</button>
<button style={btn("#111827")} onClick={apagarTodas}>🗑 Apagar Todas</button>
</div>

<button style={btn("#9333ea")} onClick={()=>setMode("historico")}>📊 Histórico</button>
<button style={btn("#ea580c")} onClick={()=>setMode("proxima")}>🚀 Próxima entrega</button>

</div>

<div style={list}>
{lista.map((d,i)=>(
<div key={d.id} style={(routeList&&i===0&&view==="pendentes")?cardHighlight:card}>
<strong>{i+1}. {d.name||"Destinatário"}</strong>
{d.street&&<div>{d.street}</div>}
{d.district&&<div>Bairro: {d.district}</div>}
{d.city&&<div>{d.city}{d.state&&` - ${d.state}`}</div>}
{d.postalCode&&<div>CEP: {d.postalCode}</div>}
{d.country&&<div>País: {d.country}</div>}
{d.phone&&<div>📞 {d.phone}</div>}

<button style={btn("#374151")} onClick={()=>setExpanded(expanded===d.id?null:d.id)}>⚙️ Ações</button>

{expanded===d.id&&(
<div style={grid2}>
{d.phone&&<a href={`tel:${d.phone}`} style={mini("#1e293b")}>☎ Ligar</a>}
{d.phone&&<a href={`https://wa.me/${d.phone}`} target="_blank" style={mini("#16a34a")}>💬 WhatsApp</a>}
{d.street&&<a href={`https://waze.com/ul?q=${encodeURIComponent(d.street+" "+(d.city||""))}`} target="_blank" style={mini("#0ea5e9")}>🚗 Waze</a>}
{d.street&&<a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.street+" "+(d.city||""))}`} target="_blank" style={mini("#2563eb")}>📍 Google</a>}
{d.phone&&<button style={mini("#0ea5e9")} onClick={()=>aCaminho(d)}>🧭 A CAMINHO</button>}
<button style={mini("#f59e0b")} onClick={()=>tirarProva(d.id)}>📸 PROVA</button>
<button style={mini("#dc2626")} onClick={()=>apagar(d.id)}>🗑 APAGAR</button>
{d.status==="nao_realizada"&&<button style={mini("#16a34a")} onClick={()=>concluir(d.id)}>✔ CONCLUIR</button>}
</div>
)}

</div>
))}
</div>

{isScannerOpen&&<CameraScanner onCapture={d=>{setIsScannerOpen(false);setPreview(d);}} onClose={()=>setIsScannerOpen(false)}/>}

{preview&&<div style={overlay}><div style={modal}>
<h3>{preview.name}</h3>
<p>{preview.street}</p>
<button style={btn("#16a34a")} onClick={()=>save(preview)}>Salvar</button>
<button style={btn("#6b7280")} onClick={()=>setPreview(null)}>Cancelar</button>
</div></div>}
</div>);
}

const app={display:"flex",flexDirection:"column",height:"100vh",fontFamily:"Inter,Arial",background:"#f3f4f6"};
const header={padding:18,background:"#fff"};
const list={flex:1,overflowY:"auto",padding:18};
const offlineBar={background:"#dc2626",color:"#fff",padding:8,textAlign:"center",fontWeight:700,marginBottom:12};
const statsBox={display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12};
const stat={background:"#f3f4f6",borderRadius:12,padding:"8px 4px",textAlign:"center",display:"flex",flexDirection:"column",fontWeight:700};
const grid2={display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12};
const grid3={display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12};
const btn=(bg:string,color="#fff")=>({background:bg,color,height:48,width:"100%",border:"2px solid #000",borderRadius:12,fontWeight:700,fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",boxSizing:"border-box",padding:"0 10px"});
const mini=(bg:string)=>({background:bg,color:"#fff",height:48,width:"100%",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:15,border:"2px solid #000",textDecoration:"none"});
const card={background:"#fff",padding:18,borderRadius:16,marginBottom:18};
const cardHighlight={...card,border:"3px solid #22c55e",boxShadow:"0 0 0 3px rgba(34,197,94,0.25)"};
const overlay={position:"fixed" as const,inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center"};
const modal={background:"#fff",padding:26,borderRadius:18,width:"90%",maxWidth:420,textAlign:"center"};
