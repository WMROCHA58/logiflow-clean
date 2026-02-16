import {useEffect,useState,useRef,useMemo} from "react";
import {auth,db,functions} from "./firebase";
import Login from "./Login";
import {onAuthStateChanged,signOut} from "firebase/auth";
import {collection,addDoc,getDocs,query,where,Timestamp,updateDoc,doc,deleteDoc} from "firebase/firestore";
import {httpsCallable} from "firebase/functions";
import {CameraScanner} from "./components/CameraScanner";
import {VoiceEngine} from "./voice/voiceEngine";
import {initUserContext} from "./modules/userContext";

type DeliveryStatus="concluida"|"nao_realizada";
type Delivery={id:string;name:string;street:string;district?:string;city:string;state?:string;postalCode?:string;country?:string;phone?:string;latitude?:number|null;longitude?:number|null;status:DeliveryStatus};

export default function App(){

const [user,setUser]=useState<any>(null);
const [all,setAll]=useState<Delivery[]>([]);
const [view,setView]=useState<"pendentes"|"concluidas">("pendentes");
const [routeList,setRouteList]=useState<Delivery[]|null>(null);
const [loading,setLoading]=useState(true);
const [isScannerOpen,setIsScannerOpen]=useState(false);
const [preview,setPreview]=useState<any>(null);
const voiceRef=useRef<VoiceEngine|null>(null);

useEffect(()=>{if(!voiceRef.current)voiceRef.current=new VoiceEngine();},[]);
useEffect(()=>{const u=onAuthStateChanged(auth,async x=>{if(x){setUser(x);await initUserContext(x.uid);}else setUser(null);setLoading(false);});return()=>u();},[]);
useEffect(()=>{if(user)load(user.uid);},[user]);

async function load(uid:string){
const q=query(collection(db,"deliveries"),where("userId","==",uid));
const snap=await getDocs(q);
setAll(snap.docs.map(d=>({id:d.id,...(d.data() as any)})));
}

const pendentes=useMemo(()=>all.filter(d=>d.status==="nao_realizada"),[all]);
const concluidas=useMemo(()=>all.filter(d=>d.status==="concluida"),[all]);

/* ========= VOICE INTENT MULTILÍNGUE ========= */

function detectIntent(t:string){
t=t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");

if(
t.includes("quantas")||t.includes("faltam")||
t.includes("how many")||t.includes("remaining")||
t.includes("cuantas")||t.includes("cuantos")
) return "COUNT";

if(
t.includes("proxima")||t.includes("seguinte")||
t.includes("next")||
t.includes("siguiente")
) return "NEXT";

return null;
}

function handleVoice(){
if(!voiceRef.current)return;

voiceRef.current.start(res=>{
const i=detectIntent(res);

if(i==="COUNT"){
voiceRef.current?.speak(`Você tem ${pendentes.length} entregas pendentes`);
}

if(i==="NEXT"){
const n=(routeList||pendentes)[0];
if(!n){
voiceRef.current?.speak("Não há entregas pendentes");
return;
}

const endereco=[
n.street,
n.district&&`bairro ${n.district}`,
n.city,
n.state
].filter(Boolean).join(", ");

voiceRef.current?.speak(`Próxima entrega para ${n.name}. Endereço: ${endereco}`);
}
});
}

/* ========= ROTA ========= */

function hav(a:number,b:number,c:number,d:number){
const R=6371,x=(c-a)*Math.PI/180,y=(d-b)*Math.PI/180;
const z=Math.sin(x/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(y/2)**2;
return R*(2*Math.atan2(Math.sqrt(z),Math.sqrt(1-z)));
}

function handleRoute(){
if(!navigator.geolocation)return;
navigator.geolocation.getCurrentPosition(p=>{
const {latitude,longitude}=p.coords;
setRouteList([...pendentes]
.filter(d=>d.latitude&&d.longitude)
.sort((a,b)=>hav(latitude,longitude,a.latitude!,a.longitude!)-hav(latitude,longitude,b.latitude!,b.longitude!)));
});
}

/* ========= FIRESTORE ========= */

async function concluir(id:string){
await updateDoc(doc(db,"deliveries",id),{status:"concluida"});
user&&load(user.uid);
}

async function apagar(id:string){
await deleteDoc(doc(db,"deliveries",id));
user&&load(user.uid);
}

async function apagarTodas(){
for(const d of(view==="pendentes"?pendentes:concluidas))
await deleteDoc(doc(db,"deliveries",d.id));
user&&load(user.uid);
}

async function save(data:any){
if(!user)return;
const geo=httpsCallable(functions,"geocodeAddress");
const g:any=await geo(data);
await addDoc(collection(db,"deliveries"),{
...data,
userId:user.uid,
latitude:g.data.latitude||null,
longitude:g.data.longitude||null,
status:"nao_realizada",
createdAt:Timestamp.now()
});
setPreview(null);
load(user.uid);
}

if(loading)return<div style={{padding:30}}>Loading...</div>;
if(!user)return<Login/>;

const lista=view==="pendentes"?(routeList||pendentes):concluidas;
const total=all.length;

/* ========= UI ========= */

return(
<div style={app}>
<div style={header}>
<h1 style={{marginBottom:14}}>🚚 LogiFlow</h1>

<div style={stats}>
<div>Total: {total}</div>
<div>Pendentes: {pendentes.length}</div>
<div>Concluídas: {concluidas.length}</div>
</div>

<div style={grid2}>
<button style={btn("#4b5563")} onClick={()=>signOut(auth)}>🚪 Sair</button>
<button style={btn("#2563eb")} onClick={()=>setIsScannerOpen(true)}>📸 Escanear</button>
<button style={btn("#059669")} onClick={handleVoice}>🎤 Falar</button>
<button style={btn("#047857")} onClick={handleRoute}>🗺️ Rota</button>
</div>

<div style={grid3}>
<button style={view==="pendentes"?btn("#2563eb"):btn("#e5e7eb","#111")} onClick={()=>setView("pendentes")}>Pendentes</button>
<button style={view==="concluidas"?btn("#7c3aed"):btn("#e5e7eb","#111")} onClick={()=>setView("concluidas")}>Concluídas</button>
<button style={btn("#111827")} onClick={apagarTodas}>🗑 Apagar</button>
</div>
</div>

<div style={list}>
{lista.map((d,i)=>(
<div key={d.id} style={{...card,...(routeList&&i===0?activeCard:{})}}>
<strong>{i+1}. {d.name}</strong>
<div>{d.street}</div>
{d.district&&<div>Bairro: {d.district}</div>}
<div>{d.city}{d.state&&` - ${d.state}`}</div>
{d.postalCode&&<div>CEP: {d.postalCode}</div>}
{d.country&&<div>País: {d.country}</div>}
{d.phone&&<div>📞 {d.phone}</div>}

<div style={grid2}>
{d.phone&&<>
<a href={`tel:${d.phone}`} style={mini("#1e293b")}>📞 Ligar</a>
<a href={`https://wa.me/${d.phone}`} target="_blank" style={mini("#16a34a")}>💬 WhatsApp</a>
</>}
<a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.street+" "+d.city)}`} target="_blank" style={mini("#2563eb")}>📍 Google</a>
<a href={`https://waze.com/ul?q=${encodeURIComponent(d.street+" "+d.city)}`} target="_blank" style={mini("#0ea5e9")}>🚗 Waze</a>
</div>

<div style={grid2}>
{d.status==="nao_realizada"&&<button style={btn("#16a34a")} onClick={()=>concluir(d.id)}>✔ Concluir</button>}
<button style={btn("#dc2626")} onClick={()=>apagar(d.id)}>🗑 Apagar</button>
</div>
</div>
))}
</div>

{isScannerOpen&&<CameraScanner onCapture={d=>{setIsScannerOpen(false);setPreview(d);}} onClose={()=>setIsScannerOpen(false)}/>}

{preview&&
<div style={overlay}>
<div style={modal}>
<h3>{preview.name}</h3>
<p>{preview.street}</p>
{preview.postalCode&&<div>CEP: {preview.postalCode}</div>}
{preview.phone&&<div>Telefone: {preview.phone}</div>}
<div style={grid2}>
<button style={btn("#16a34a")} onClick={()=>save(preview)}>Salvar</button>
<button style={btn("#6b7280")} onClick={()=>setPreview(null)}>Cancelar</button>
</div>
</div>
</div>}
</div>);
}

/* ========= STYLES ========= */

const app={display:"flex",flexDirection:"column",height:"100vh",fontFamily:"Inter,Arial",background:"#f3f4f6"};
const header={padding:18,background:"#fff",boxShadow:"0 2px 8px rgba(0,0,0,0.05)"};
const stats={display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12,fontWeight:600,textAlign:"center"};
const list={flex:1,overflowY:"auto",padding:18};
const grid2={display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12};
const grid3={display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12};
const btn=(bg:string,color="#fff")=>({background:bg,color,height:44,border:"none",borderRadius:12,fontWeight:600,width:"100%"});
const mini=(bg:string)=>({background:bg,color:"#fff",height:40,borderRadius:10,textDecoration:"none",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:600});
const card={background:"#fff",padding:18,borderRadius:16,marginBottom:18,boxShadow:"0 6px 18px rgba(0,0,0,0.06)"};
const activeCard={border:"2px solid #16a34a",boxShadow:"0 0 0 3px rgba(22,163,74,0.2)"};
const overlay={position:"fixed" as const,inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center"};
const modal={background:"#fff",padding:26,borderRadius:18,width:"90%",maxWidth:420,textAlign:"center"};
