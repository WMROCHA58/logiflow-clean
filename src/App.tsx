import { useEffect,useState,useRef } from "react";
import { auth } from "./firebase";
import Login from "./Login";
import { onAuthStateChanged,signOut } from "firebase/auth";
import { collection,addDoc,getDocs,query,where,Timestamp,updateDoc,doc,deleteDoc } from "firebase/firestore";
import { db,functions } from "./firebase";
import { httpsCallable } from "firebase/functions";
import { CameraScanner } from "./components/CameraScanner";
import { VoiceEngine } from "./voice/voiceEngine";
import { initUserContext } from "./modules/userContext";
import { detectUserLanguage } from "./i18n/languages";
import { t } from "./i18n/translator";

type DeliveryStatus="concluida"|"nao_realizada";
type Delivery={id:string;name:string;street:string;district?:string;city:string;state?:string;postalCode?:string;country?:string;phone?:string;latitude?:number;longitude?:number;status:DeliveryStatus};

export default function App(){

const userLang=detectUserLanguage();
const [user,setUser]=useState<any>(null);
const [deliveries,setDeliveries]=useState<Delivery[]>([]);
const deliveriesRef=useRef<Delivery[]>([]);
const [loading,setLoading]=useState(true);
const [isScannerOpen,setIsScannerOpen]=useState(false);
const [previewData,setPreviewData]=useState<any>(null);
const isProcessingVoiceRef=useRef(false);
const voiceRef=useRef<VoiceEngine|null>(null);

useEffect(()=>{ if(!voiceRef.current)voiceRef.current=new VoiceEngine(); },[]);

useEffect(()=>{
const unsub=onAuthStateChanged(auth,async usr=>{
if(usr){setUser(usr);await initUserContext(usr.uid);}
else setUser(null);
setLoading(false);
});
return()=>unsub();
},[]);

useEffect(()=>{ if(user)loadDeliveries(user.uid); },[user]);

async function loadDeliveries(uid:string){
const q=query(collection(db,"deliveries"),where("userId","==",uid));
const snap=await getDocs(q);
const list:Delivery[]=snap.docs.map(d=>({id:d.id,...(d.data() as Omit<Delivery,"id">)}));
setDeliveries(list);
deliveriesRef.current=list;
}

async function saveDelivery(data:any){
if(!user)return;

let latitude:number|undefined;
let longitude:number|undefined;

try{
const geocodeFunction=httpsCallable(functions,"geocodeAddress");
const geoResult:any=await geocodeFunction({
street:data?.street||"",
city:data?.city||"",
state:data?.state||"",
postalCode:data?.postalCode||"",
country:data?.country||""
});
latitude=geoResult.data.latitude;
longitude=geoResult.data.longitude;
}catch(e){
console.error("Erro geocode:",e);
}

await addDoc(collection(db,"deliveries"),{
userId:user.uid,
name:data?.name||"",
street:data?.street||"",
district:data?.district||"",
city:data?.city||"",
state:data?.state||"",
postalCode:data?.postalCode||"",
country:data?.country||"",
phone:data?.phone||"",
latitude:latitude||null,
longitude:longitude||null,
status:"nao_realizada",
createdAt:Timestamp.now()
});

setPreviewData(null);
await loadDeliveries(user.uid);
}

async function concluirEntrega(id:string){
await updateDoc(doc(db,"deliveries",id),{status:"concluida"});
if(user)await loadDeliveries(user.uid);
}

async function apagarEntrega(id:string){
await deleteDoc(doc(db,"deliveries",id));
if(user)await loadDeliveries(user.uid);
}

async function apagarTodas(){
if(!user)return;
const snap=await getDocs(query(collection(db,"deliveries"),where("userId","==",user.uid)));
for(const d of snap.docs)await deleteDoc(doc(db,"deliveries",d.id));
await loadDeliveries(user.uid);
}

async function logout(){await signOut(auth);}

function detectIntent(text:string):"NEXT"|"REPEAT"|"COUNT"|null{
const t=text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
if(t.includes("quantas")||t.includes("faltam")||t.includes("restam")||t.includes("how many")||t.includes("pending")||t.includes("cuantas")||t.includes("cuántas")||t.includes("pendientes"))return"COUNT";
if(t.includes("proxima")||t.includes("seguinte")||t.includes("next")||t.includes("siguiente"))return"NEXT";
if(t.includes("repetir")||t.includes("de novo")||t.includes("repeat")||t.includes("direccion")||t.includes("dirección"))return"REPEAT";
return null;
}

function handleVoice(){
if(isProcessingVoiceRef.current||!voiceRef.current)return;
isProcessingVoiceRef.current=true;

voiceRef.current.start((res:string)=>{
if(!res||res.trim()==="")return;
const intent=detectIntent(res);

if(intent==="COUNT"){
const p=deliveriesRef.current.filter(d=>d.status==="nao_realizada").length;
voiceRef.current?.speak(userLang==="en"?`You have ${p} pending deliveries`:userLang==="es"?`Tienes ${p} entregas pendientes`:`Você tem ${p} entregas pendentes`);
}

else if(intent==="NEXT"){
const next=deliveriesRef.current.find(d=>d.status==="nao_realizada");
if(!next){
voiceRef.current?.speak(userLang==="en"?"No pending deliveries":userLang==="es"?"No hay entregas pendientes":"Não há entregas pendentes");
}else{
voiceRef.current?.speak(userLang==="en"?`Next delivery: ${next.name}. ${next.street}, ${next.city}`:userLang==="es"?`Siguiente entrega: ${next.name}. ${next.street}, ${next.city}`:`Próxima entrega: ${next.name}. ${next.street}, ${next.city}`);
}
}

else if(intent==="REPEAT"){
const next=deliveriesRef.current.find(d=>d.status==="nao_realizada");
if(next){
voiceRef.current?.speak(userLang==="en"?`Repeating: ${next.name}. ${next.street}, ${next.city}`:userLang==="es"?`Repitiendo: ${next.name}. ${next.street}, ${next.city}`:`Repetindo: ${next.name}. ${next.street}, ${next.city}`);
}
}

else{
voiceRef.current?.speak(userLang==="en"?"Command not recognized":userLang==="es"?"Comando no reconocido":"Comando não reconhecido");
}

},()=>{});
}

if(loading)return <div style={{padding:30}}>Loading...</div>;
if(!user)return <Login/>;

return(
<div style={{minHeight:"100vh",background:"#f3f4f6",padding:24,fontFamily:"Arial"}}>
<div style={{maxWidth:800,margin:"0 auto"}}>
<h1>🚚 LogiFlow</h1>

<button style={mainBtn("#6b7280")} onClick={logout}>{userLang==="en"?"Logout":userLang==="es"?"Salir":"Sair"}</button>
<button style={mainBtn("#2563eb")} onClick={()=>setIsScannerOpen(true)}>📸 {t("scan",userLang)}</button>
<button style={mainBtn("#10b981")} onClick={handleVoice}>🎤 {t("speak",userLang)}</button>
<button style={mainBtn("#111827")} onClick={apagarTodas}>{userLang==="en"?"Delete All":userLang==="es"?"Eliminar Todas":"Apagar Todas"}</button>

{deliveries.map((d,i)=>(
<div key={d.id} style={{background:"#fff",padding:18,borderRadius:12,marginTop:16,boxShadow:"0 4px 10px rgba(0,0,0,0.05)"}}>
<strong>{i+1}. {d.name}</strong>
<div>{d.street}</div>
{d.district&&<div>{userLang==="en"?"District":userLang==="es"?"Barrio":"Bairro"}: {d.district}</div>}
<div>{d.city}{d.state&&` - ${d.state}`}</div>
{d.postalCode&&<div>{userLang==="en"?"Postal Code":userLang==="es"?"Código Postal":"CEP"}: {d.postalCode}</div>}
{d.country&&<div>{userLang==="en"?"Country":"País"}: {d.country}</div>}
{d.phone&&<div>📞 {d.phone}</div>}

<div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:12}}>
{d.phone&&<>
<a href={`tel:${d.phone}`} style={actionBtn("#4b5563")}>📞 {userLang==="en"?"Call":"Ligar"}</a>
<a href={`https://wa.me/${d.phone}`} target="_blank" rel="noopener noreferrer" style={actionBtn("#25D366")}>WhatsApp</a>
</>}
<a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.street+" "+d.city)}`} target="_blank" rel="noopener noreferrer" style={actionBtn("#2563eb")}>📍 Google</a>
<a href={`https://waze.com/ul?q=${encodeURIComponent(d.street+" "+d.city)}`} target="_blank" rel="noopener noreferrer" style={actionBtn("#06b6d4")}>🚗 Waze</a>
</div>

{d.status==="nao_realizada"&&<button style={smallBtn("#16a34a")} onClick={()=>concluirEntrega(d.id)}>✔ {t("concludeDelivery",userLang)}</button>}
<button style={smallBtn("#b91c1c")} onClick={()=>apagarEntrega(d.id)}>🗑 {t("deleteDelivery",userLang)}</button>

</div>
))}
</div>

{isScannerOpen&&<CameraScanner onCapture={(data)=>{setIsScannerOpen(false);setPreviewData(data);}} onClose={()=>setIsScannerOpen(false)}/>}

{previewData&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center"}}>
<div style={{background:"#fff",padding:20,borderRadius:12,width:"90%",maxWidth:400}}>
<h3>{previewData.name}</h3>
<p>{previewData.street}</p>
<button style={mainBtn("#16a34a")} onClick={()=>saveDelivery(previewData)}>Save</button>
<button style={mainBtn("#6b7280")} onClick={()=>setPreviewData(null)}>Cancel</button>
</div>
</div>}
</div>
);
}

function mainBtn(color:string){return{width:"100%",padding:12,marginBottom:8,background:color,color:"#fff",border:"none",borderRadius:8,fontWeight:"bold"}}
function smallBtn(color:string){return{marginTop:10,padding:"6px 10px",background:color,color:"#fff",border:"none",borderRadius:6}}
function actionBtn(color:string){return{background:color,color:"#fff",padding:"6px 10px",borderRadius:6,textDecoration:"none",fontSize:13}}
