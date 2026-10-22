const TZ={ug:"Africa/Kampala",dubai:"Asia/Dubai",italy:"Europe/Rome"};
const zoneNames={"Africa/Kampala":"Uganda","Asia/Dubai":"Dubai","Europe/Rome":"Italy / Europe"};
const shiftStartHour=6, shiftEndHour=16;
const SHIFT_TIME_ZONE="Asia/Dubai"; // Schedule is interpreted in Dubai local time; display can be converted.
// Contract dates are the Dubai-local dates shown in the screenshots.
const knownShiftDates=new Set(["2026-10-15","2026-10-16","2026-10-17","2026-10-18","2026-10-19","2026-10-22"]);
const timezoneSelect=document.getElementById("primaryTimezone");
try{const savedZone=localStorage.getItem("ogramDashboardTimezone:AndrewWamani:ID432384");if(savedZone&&zoneNames[savedZone])timezoneSelect.value=savedZone;}catch(_){}
function primaryZone(){return timezoneSelect.value;}
// Convert a wall-clock date/time in an IANA zone to an absolute instant, including DST.
function zonedDateTime(y,m,d,h=0,min=0,sec=0,zone=primaryZone()){
 const target=Date.UTC(y,m-1,d,h,min,sec);let guess=target;
 for(let i=0;i<4;i++){
  const p=partsInZone(new Date(guess),zone);
  const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  guess+=target-represented;
 }
 return new Date(guess);
}
function contractBounds(){
 // Contract begins and ends on the Dubai-local calendar dates in the screenshot.
 return {start:zonedDateTime(2026,10,15,0,0,0,"Asia/Dubai"),end:zonedDateTime(2026,12,16,0,0,0,"Asia/Dubai")-1};
}
function partsInZone(date,zone){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(date);return Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));}
function clock(date,zone){return new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(date);}
function dateLabel(date,zone){return new Intl.DateTimeFormat("en-GB",{timeZone:zone,day:"numeric",month:"short",year:"numeric"}).format(date);}
function fmtDuration(ms){let s=Math.max(0,Math.floor(ms/1000));const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;if(d>0)return `${d}d ${h}h`;if(h>0)return `${h}h ${m}m`;return `${m}m ${s}s`;}
function update(){
 const now=new Date();
 document.getElementById("clockUganda").textContent=clock(now,TZ.ug);
 document.getElementById("clockDubai").textContent=clock(now,TZ.dubai);
 document.getElementById("clockItaly").textContent=clock(now,TZ.italy);
 const zone=primaryZone(), bounds=contractBounds(), contractStart=bounds.start, contractEnd=bounds.end;
 const total=contractEnd-contractStart, elapsed=now-contractStart;
 const days=Math.max(0,Math.ceil((contractEnd-now)/86400000));
 document.getElementById("daysRemaining").textContent=now<contractStart?Math.ceil((contractStart-now)/86400000)+" days to start":now>=contractEnd?"0 days":days+" days";
 document.getElementById("contractStatus").textContent=now<contractStart?"Not started":now>=contractEnd?"Contract ended":"Until "+dateLabel(contractEnd,zone);
 const pct=Math.min(100,Math.max(0,elapsed/total*100));
 document.getElementById("progress").textContent=Math.round(pct)+"%";
 document.getElementById("contractDates").textContent="Contract dates (Dubai-local contract dates, shown in "+zoneNames[zone]+" time): "+dateLabel(contractStart,zone)+" – "+dateLabel(contractEnd,zone);
 document.getElementById("timezoneSelected").textContent="Dashboard uses "+zoneNames[zone]+" time";
 document.getElementById("shiftHoursTitle").textContent="Shift hours ("+zoneNames[zone]+")";
 updateShift(now);
}
function updateShift(now){
 const input=document.getElementById("shiftDate").value||"2026-10-22";
 const [y,m,d]=input.split("-").map(Number);
 const displayZone=primaryZone();
 const el=document.getElementById("shiftCountdown"), status=document.getElementById("shiftStatus");
 const hoursValue=document.querySelector("#shiftHoursTitle + .value");
 if(!knownShiftDates.has(input)){
  el.textContent="Not confirmed";status.textContent="Check Ogram schedule";
  document.getElementById("shiftHoursTitle").textContent="Shift hours (not confirmed)";
  hoursValue.textContent="—";
  document.getElementById("selectedDateNote").textContent="Selected date: "+input+". The screenshots do not confirm this date’s shift hours, so no countdown is shown. Check Ogram before relying on a shift time.";
  return;
 }
 // The schedule's date and wall-clock hours are interpreted in Dubai, then displayed in the chosen zone.
 const start=zonedDateTime(y,m,d,shiftStartHour,0,0,SHIFT_TIME_ZONE);
 const end=zonedDateTime(y,m,d,shiftEndHour,0,0,SHIFT_TIME_ZONE);
 document.getElementById("shiftHoursTitle").textContent="Shift hours ("+zoneNames[displayZone]+")";
 hoursValue.textContent=clock(start,displayZone)+"–"+clock(end,displayZone);
 if(now<start){el.textContent=fmtDuration(start-now);status.textContent="Until shift starts";}
 else if(now<end){el.textContent=fmtDuration(end-now);status.textContent="Time until shift ends";}
 else{el.textContent="Shift window ended";status.textContent="Confirm attendance in Ogram if required";}
 document.getElementById("selectedDateNote").textContent="Selected shift date: "+input+" (Dubai schedule). Displayed as "+clock(start,displayZone)+"–"+clock(end,displayZone)+" in "+zoneNames[displayZone]+" time. Verify attendance in Ogram.";
}
document.getElementById("shiftDate").addEventListener("change",()=>{window.dispatchEvent(new Event("ogram-shift-date-changed"));update();});
timezoneSelect.addEventListener("change",()=>{try{localStorage.setItem("ogramDashboardTimezone:AndrewWamani:ID432384",timezoneSelect.value)}catch(_){};update();});
document.getElementById("copyAddress").addEventListener("click",async()=>{
 const address="Dubai Festival City Mall - Crescent Rd - Dubai", status=document.getElementById("copyStatus");
 const confirmPanel=document.getElementById("endShiftConfirmation");
 try{await navigator.clipboard.writeText(address);status.textContent="Address copied!";confirmPanel.classList.add("show");}
 catch(e){const t=document.createElement("textarea");t.value=address;t.readOnly=true;t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();let ok=false;try{ok=document.execCommand("copy")}catch(_){}t.remove();status.textContent=ok?"Address copied!":"Press and hold the address text to select and copy it.";if(ok)confirmPanel.classList.add("show");}
});
// Local-only, date-specific swipe confirmation. It never communicates with Ogram.
const confirmationBaseKey="ogramShiftSelfConfirmation:AndrewWamani:ID432384:";
function selectedShiftDate(){return document.getElementById("shiftDate").value||"2026-10-22";}
function confirmationKey(){return confirmationBaseKey+selectedShiftDate();}
function resetSwipeVisual(){
 const track=document.getElementById("swipeTrack"), knob=document.getElementById("swipeKnob"), label=document.getElementById("swipeLabel"), status=document.getElementById("endShiftStatus");
 track.classList.remove("done");label.textContent="Swipe to confirm finished";knob.textContent="›";knob.style.transition="none";knob.style.left="4px";status.textContent="";
}
function restoreSavedForSelectedDate(){
 const track=document.getElementById("swipeTrack"), knob=document.getElementById("swipeKnob"), label=document.getElementById("swipeLabel"), status=document.getElementById("endShiftStatus");
 resetSwipeVisual();
 try{
  const saved=JSON.parse(localStorage.getItem(confirmationKey())||"null");
  if(!saved)return false;
  track.classList.add("done");label.textContent="This shift is self-confirmed";knob.textContent="✓";
  requestAnimationFrame(()=>{knob.style.left=Math.max(4,track.clientWidth-knob.offsetWidth-4)+"px";});
  const stamp=saved.confirmedAt?new Date(saved.confirmedAt):null;
  status.textContent="Saved self-confirmation for "+selectedShiftDate()+": "+(stamp?new Intl.DateTimeFormat("en-GB",{timeZone:saved.timezone||primaryZone(),dateStyle:"medium",timeStyle:"medium"}).format(stamp):"timestamp unavailable")+". Local only; Ogram is unchanged.";
  return true;
 }catch(_){
  status.textContent="This browser could not read the saved confirmation. It may not be stored on this device.";
  return false;
 }
}
function resetSwipeForSelectedDate(){restoreSavedForSelectedDate();}
(()=>{
 const track=document.getElementById("swipeTrack"), knob=document.getElementById("swipeKnob"), label=document.getElementById("swipeLabel"), status=document.getElementById("endShiftStatus");
 let dragging=false,startX=0,offset=0,completed=false;
 const max=()=>Math.max(0,track.clientWidth-knob.offsetWidth-8);
 function loadState(){completed=restoreSavedForSelectedDate();offset=completed?max():0;}
 function paint(x){offset=Math.max(0,Math.min(max(),x));knob.style.left=(4+offset)+"px";}
 loadState();
 window.addEventListener("ogram-shift-date-changed",loadState);
 function begin(e){if(completed)return;dragging=true;startX=e.clientX;knob.setPointerCapture?.(e.pointerId);}
 function move(e){
  if(!dragging)return;
  paint(offset+(e.clientX-startX));startX=e.clientX;
  if(offset>=max()*0.82){
   completed=true;dragging=false;paint(max());track.classList.add("done");label.textContent="Shift confirmed in this page";knob.textContent="✓";
   const stamp=new Date();
   status.textContent="Self-confirmed for "+selectedShiftDate()+" at "+new Intl.DateTimeFormat("en-GB",{timeZone:primaryZone(),dateStyle:"medium",timeStyle:"medium"}).format(stamp)+" ("+zoneNames[primaryZone()]+" time). Ogram is unchanged.";
   try{
    localStorage.setItem(confirmationKey(),JSON.stringify({shiftDate:selectedShiftDate(),confirmedAt:stamp.toISOString(),timezone:primaryZone(),address:"Dubai Festival City Mall - Crescent Rd - Dubai"}));
   }catch(_){
    status.textContent="Confirmation shown for this session, but browser storage failed. It may not persist after closing this page. Ogram is unchanged.";
   }
  }
 }
 function end(){if(!dragging)return;dragging=false;if(!completed){offset=0;knob.style.transition="left .18s ease";paint(0);setTimeout(()=>knob.style.transition="",200);}}
 knob.addEventListener("pointerdown",begin);knob.addEventListener("pointermove",move);knob.addEventListener("pointerup",end);knob.addEventListener("pointercancel",end);
 window.addEventListener("resize",()=>{if(completed)paint(max());});
})();
update();setInterval(update,1000);

// Installed PWA support: request persistent origin storage where the browser permits it.
(async()=>{
 const status=document.getElementById("storageStatus");
 try {
  if (navigator.storage && navigator.storage.persist) {
   const already=await navigator.storage.persisted();
   const granted=already || await navigator.storage.persist();
   status.textContent=granted
    ? "Persistent storage is enabled for this installed dashboard on this device. Keep a backup as extra protection."
    : "The browser did not grant persistent-storage protection. Data usually remains, but the browser may clear it; export a backup.";
  } else {
   status.textContent="This browser does not expose persistent-storage protection. Data may remain locally, but export a backup.";
  }
 } catch (_) {
  status.textContent="Could not verify persistent-storage protection. Export a backup for safety.";
 }
})();

let deferredInstallPrompt=null;
const installButton=document.getElementById("installAppButton");
window.addEventListener("beforeinstallprompt",event=>{
 event.preventDefault();deferredInstallPrompt=event;installButton.style.display="block";
});
installButton.addEventListener("click",async()=>{
 if(!deferredInstallPrompt){installButton.textContent="Use browser menu → Install app";return;}
 deferredInstallPrompt.prompt();
 try{await deferredInstallPrompt.userChoice;}catch(_){}
 deferredInstallPrompt=null;installButton.style.display="none";
});
window.addEventListener("appinstalled",()=>{
 installButton.style.display="none";
 const st=document.getElementById("storageStatus");
 if(st)st.textContent += " App installation detected.";
});

// Export only this dashboard's namespaced settings and confirmations.
const DASHBOARD_STORAGE_PREFIXES=[
 "ogramDashboardTimezone:AndrewWamani:ID432384",
 "ogramShiftSelfConfirmation:AndrewWamani:ID432384:"
];
document.getElementById("exportBackupButton").addEventListener("click",()=>{
 try {
  const items={};
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);
   if(key && DASHBOARD_STORAGE_PREFIXES.some(prefix=>key.startsWith(prefix)))items[key]=localStorage.getItem(key);
  }
  const payload={format:"AndrewWamaniShiftDashboardBackup",version:1,exportedAt:new Date().toISOString(),items};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="Andrew_Wamani_Dashboard_Backup.json";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  document.getElementById("storageStatus").textContent="Backup exported. Keep the JSON file somewhere safe.";
 } catch(_) {
  document.getElementById("storageStatus").textContent="Backup export failed in this viewer. Open the installed dashboard in Chrome and try again.";
 }
});
document.getElementById("importBackupButton").addEventListener("click",()=>document.getElementById("backupFileInput").click());
document.getElementById("backupFileInput").addEventListener("change",async event=>{
 const file=event.target.files && event.target.files[0];if(!file)return;
 try {
  const payload=JSON.parse(await file.text());
  if(payload.format!=="AndrewWamaniShiftDashboardBackup" || payload.version!==1 || !payload.items || typeof payload.items!=="object")throw new Error("Invalid backup");
  const entries=Object.entries(payload.items);
  if(entries.some(([key,value])=>!DASHBOARD_STORAGE_PREFIXES.some(prefix=>key.startsWith(prefix)) || typeof value!=="string"))throw new Error("Unexpected backup data");
  for(const [key,value] of entries)localStorage.setItem(key,value);
  document.getElementById("storageStatus").textContent="Backup restored. Reload the dashboard to refresh all saved settings and confirmations.";
 } catch(_) {
  document.getElementById("storageStatus").textContent="Could not restore that backup. Choose a valid backup exported from Andrew’s dashboard.";
 } finally {event.target.value="";}
});
if("serviceWorker" in navigator && location.protocol!=="file:"){
 window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(()=>{
  const st=document.getElementById("storageStatus");
  if(st)st.textContent += " Offline caching could not be enabled in this browser.";
 }));
}

const STORAGE_KEY="dkasuMultiProfileDashboard.v1";
const ACTIVE_KEY="dkasuMultiProfileDashboard.activeProfile.v1";
const TZ_OPTIONS=["Asia/Dubai","Africa/Kampala","Europe/Rome"];
const TZ_NAMES={"Asia/Dubai":"Dubai","Africa/Kampala":"Uganda","Europe/Rome":"Italy / Europe"};
let profiles={};
let activeProfileId=null;
let editingProfileId=null;
let tickHandle=null;
let activeProfileStorageKey=null;

function uid(){return "p_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,9);}
function defaultAndrew() {
 return {
  id:"andrew-wamani-id432384", name:"Andrew Wamani", email:"wamaniandrew26@gmail.com",
  profileId:"ID432384", swipeId:"ID55911", job:"Warehouse Operator",
  company:"Transcorp International Logistics", location:"UAEW Warehouse – DIP 2",
  address:"Dubai Festival City Mall - Crescent Rd - Dubai",
  contractStart:"2026-10-15", contractEnd:"2026-12-15",
  displayZone:"Asia/Dubai", scheduleZone:"Asia/Dubai",
  schedules:{
   "2026-10-15":{start:"06:00",end:"16:00"},
   "2026-10-16":{start:"06:00",end:"16:00"},
   "2026-10-17":{start:"06:00",end:"16:00"},
   "2026-10-18":{start:"06:00",end:"16:00"},
   "2026-10-19":{start:"06:00",end:"16:00"},
   "2026-10-22":{start:"06:00",end:"16:00"}
  },
  confirmations:{},
  createdAt:new Date().toISOString(),
  updatedAt:new Date().toISOString()
 };
}
function loadStore() {
 try {
  const raw=localStorage.getItem(STORAGE_KEY);
  if(raw) {
   const parsed=JSON.parse(raw);
   if(parsed && parsed.version===1 && Array.isArray(parsed.profiles)) {
    profiles={};
    for(const p of parsed.profiles) if(p && typeof p.id==="string" && typeof p.name==="string") profiles[p.id]=normalizeProfile(p);
   }
  }
 } catch(e){ console.warn("Could not load profile data",e); }
 if(!Object.keys(profiles).length) {
  const a=defaultAndrew(); profiles[a.id]=a; saveStore();
 }
}
function normalizeProfile(p) {
 return {
  id:String(p.id||uid()),name:String(p.name||"Unnamed profile"),email:String(p.email||""),
  profileId:String(p.profileId||""),swipeId:String(p.swipeId||""),job:String(p.job||""),
  company:String(p.company||""),location:String(p.location||""),address:String(p.address||""),
  contractStart:String(p.contractStart||""),contractEnd:String(p.contractEnd||""),
  displayZone:TZ_OPTIONS.includes(p.displayZone)?p.displayZone:"Asia/Dubai",
  scheduleZone:TZ_OPTIONS.includes(p.scheduleZone)?p.scheduleZone:"Asia/Dubai",
  schedules:(p.schedules&&typeof p.schedules==="object")?p.schedules:{},
  confirmations:(p.confirmations&&typeof p.confirmations==="object")?p.confirmations:{},
  createdAt:p.createdAt||new Date().toISOString(),updatedAt:p.updatedAt||new Date().toISOString()
 };
}
function saveStore() {
 try {
  localStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,updatedAt:new Date().toISOString(),profiles:Object.values(profiles)}));
  document.getElementById("storageStatus").textContent="Profile data saved on this device.";
  return true;
 } catch(e) {
  document.getElementById("storageStatus").textContent="Could not save data. Storage may be full or blocked; export a backup and check browser permissions.";
  return false;
 }
}
function activeProfile(){return activeProfileId?profiles[activeProfileId]:null;}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function showOnly(id) {
 for(const panel of ["profilePicker","profileEditor","backupPanel","activeProfilePanel"]) document.getElementById(panel).classList.toggle("hidden",panel!==id);
}
function renderProfileList() {
 const host=document.getElementById("profileList"); host.innerHTML="";
 const all=Object.values(profiles).sort((a,b)=>a.name.localeCompare(b.name));
 if(!all.length) host.innerHTML='<p>No profiles yet. Add a profile to begin.</p>';
 for(const p of all) {
  const btn=document.createElement("button");btn.type="button";btn.className="profile-choice"+(p.id===activeProfileId?" active":"");
  btn.innerHTML='<div class="avatar">'+esc(p.name.trim().split(/\s+/).map(x=>x[0]).join("").slice(0,2).toUpperCase())+'</div><div class="profile-meta"><strong>'+esc(p.name)+'</strong><span>'+esc([p.job,p.email].filter(Boolean).join(" · "))+'</span></div><span aria-hidden="true">›</span>';
  btn.addEventListener("click",()=>openProfile(p.id));host.appendChild(btn);
 }
}
function openProfile(id) {
 if(!profiles[id]) return;
 activeProfileId=id;localStorage.setItem(ACTIVE_KEY,id);
 renderProfileList();renderDashboard(profiles[id]);showOnly("activeProfilePanel");
}
function fillEditor(p) {
 const fields={pName:p?.name||"",pEmail:p?.email||"",pProfileId:p?.profileId||"",pSwipeId:p?.swipeId||"",pJob:p?.job||"",pCompany:p?.company||"",pLocation:p?.location||"",pAddress:p?.address||"",pContractStart:p?.contractStart||"",pContractEnd:p?.contractEnd||"",pTimezone:p?.displayZone||"Asia/Dubai",pShiftZone:p?.scheduleZone||"Asia/Dubai",pSchedules:Object.entries(p?.schedules||{}).sort(([a],[b])=>a.localeCompare(b)).map(([date,s])=>`${date},${s.start},${s.end}`).join("\n")};
 for(const [id,value] of Object.entries(fields))document.getElementById(id).value=value;
 document.getElementById("editorTitle").textContent=p?"Edit profile":"Add profile";
}
function startAdd(){editingProfileId=null;fillEditor(null);showOnly("profileEditor");}
function startEdit(){const p=activeProfile();if(!p)return;editingProfileId=p.id;fillEditor(p);showOnly("profileEditor");}
function saveEditor() {
 const name=document.getElementById("pName").value.trim(), address=document.getElementById("pAddress").value.trim();
 if(!name){alert("Enter the worker's full name.");return;}
 if(!address){alert("Enter the work address.");return;}
 const start=document.getElementById("pContractStart").value,end=document.getElementById("pContractEnd").value;
 if(start&&end&&end<start){alert("Contract end date must be on or after the start date.");return;}
 const schedules={};const lines=document.getElementById("pSchedules").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 for(let i=0;i<lines.length;i++) {
  const m=lines[i].match(/^(\d{4}-\d{2}-\d{2})\s*,\s*(\d{2}:\d{2})\s*,\s*(\d{2}:\d{2})$/);
  if(!m){alert("Schedule line "+(i+1)+" is invalid. Use YYYY-MM-DD,HH:MM,HH:MM.");return;}
  if(m[2]>"23:59"||m[3]>"23:59"){alert("Schedule times must be between 00:00 and 23:59.");return;}
  if(m[3]<=m[2]){alert("End time must be after start time for each shift. Overnight shifts are not supported yet.");return;}
  if(schedules[m[1]]){alert("Duplicate schedule date: "+m[1]);return;}
  schedules[m[1]]={start:m[2],end:m[3]};
 }
 const old=editingProfileId?profiles[editingProfileId]:null;
 const p=normalizeProfile({
  ...(old||{id:uid(),createdAt:new Date().toISOString(),confirmations:{}}),
  name,email:document.getElementById("pEmail").value.trim(),
  profileId:document.getElementById("pProfileId").value.trim(),swipeId:document.getElementById("pSwipeId").value.trim(),
  job:document.getElementById("pJob").value.trim(),company:document.getElementById("pCompany").value.trim(),
  location:document.getElementById("pLocation").value.trim(),address,
  contractStart:start,contractEnd:end,
  displayZone:document.getElementById("pTimezone").value,scheduleZone:document.getElementById("pShiftZone").value,
  schedules,confirmations:old?.confirmations||{},updatedAt:new Date().toISOString()
 });
 profiles[p.id]=p;activeProfileId=p.id;saveStore();openProfile(p.id);
}
function deleteActive() {
 const p=activeProfile();if(!p)return;
 if(!confirm("Delete "+p.name+"'s profile, schedules, and local confirmations from this device? Export a backup first if needed."))return;
 delete profiles[p.id];if(activeProfileId===p.id)activeProfileId=null;localStorage.removeItem(ACTIVE_KEY);saveStore();renderProfileList();showOnly("profilePicker");
}
function zoneParts(date,zone) {
 const parts=new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(date);
 return Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
}
function zonedDateTime(y,m,d,h=0,mi=0,sec=0,zone="Asia/Dubai") {
 const target=Date.UTC(y,m-1,d,h,mi,sec);let guess=target;
 for(let i=0;i<4;i++){const p=zoneParts(new Date(guess),zone);const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);guess+=target-represented;}
 return new Date(guess);
}
function formatClock(date,zone){return new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(date);}
function fmtDuration(ms){let s=Math.max(0,Math.floor(ms/1000));const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;return (d?d+"d ":"")+(h?String(h).padStart(2,"0")+"h ":"")+String(m).padStart(2,"0")+"m "+String(s).padStart(2,"0")+"s";}
function dateLabel(date,zone){return new Intl.DateTimeFormat("en-GB",{timeZone:zone,day:"numeric",month:"short",year:"numeric"}).format(date);}
function renderDashboard(p) {
 const template=document.getElementById("dashboardTemplate").innerHTML;
 const host=document.getElementById("activeProfileView");
 host.innerHTML=template;
 const replaceMap={
  "Andrew Wamani":p.name,"wamaniandrew26@gmail.com":p.email,"ID432384":p.profileId,"ID55911":p.swipeId,
  "Warehouse Operator":p.job,"Transcorp International Logistics":p.company,"UAEW Warehouse – DIP 2":p.location,
  "Dubai Festival City Mall - Crescent Rd - Dubai":p.address,
  "15 Oct – 15 Dec 2026":(p.contractStart&&p.contractEnd)?`${p.contractStart} – ${p.contractEnd}`:"Contract dates not set",
  "06:00–16:00": "Shift times from profile schedule"
 };
 for(const el of host.querySelectorAll("*")) {
  if(el.children.length===0) {
   let txt=el.textContent;
   for(const [a,b] of Object.entries(replaceMap))if(a)txt=txt.split(a).join(b||"Not provided");
   if(txt!==el.textContent)el.textContent=txt;
  }
 }
 const select=host.querySelector("#primaryTimezone");if(select)select.value=p.displayZone;
 const dateInput=host.querySelector("#shiftDate");
 if(dateInput) {
  const dates=Object.keys(p.schedules).sort();
  dateInput.min=p.contractStart||dates[0]||"";
  dateInput.max=p.contractEnd||dates[dates.length-1]||"";
  dateInput.value=dates.includes(new Date().toISOString().slice(0,10))?new Date().toISOString().slice(0,10):(dates[0]||p.contractStart||"");
 }
 const scheduleSection=host.querySelector(".schedule");
 if(scheduleSection) {
  scheduleSection.innerHTML="";
  const dates=Object.keys(p.schedules).sort();
  if(!dates.length)scheduleSection.innerHTML='<div class="day"><div><strong>No shifts added</strong></div><span>Edit profile to add dates</span></div>';
  for(const d of dates) {
   const day=document.createElement("div");day.className="day";
   day.innerHTML='<div><strong>'+esc(d)+'</strong></div><span>'+esc(p.schedules[d].start)+' – '+esc(p.schedules[d].end)+' ('+esc(TZ_NAMES[p.scheduleZone])+')</span>';
   scheduleSection.appendChild(day);
  }
 }
 // Install handlers on the single active profile DOM.
 const primary=host.querySelector("#primaryTimezone");
 const copy=host.querySelector("#copyAddress");
 const shiftDate=host.querySelector("#shiftDate");
 if(primary)primary.addEventListener("change",()=>{p.displayZone=primary.value;saveStore();updateDashboardTick(p,host);});
 if(shiftDate)shiftDate.addEventListener("change",()=>{updateDashboardTick(p,host);restoreConfirmation(p,host);});
 if(copy)copy.addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText(p.address);host.querySelector("#copyStatus").textContent="Address copied."}
  catch(_){host.querySelector("#copyStatus").textContent="Copy blocked. Press and hold the address to copy it manually."}
  const c=host.querySelector("#endShiftConfirmation");if(c)c.classList.add("show");
 });
 setupSwipe(p,host);
 updateDashboardTick(p,host);
 if(tickHandle)clearInterval(tickHandle);
 tickHandle=setInterval(()=>{if(activeProfileId===p.id)updateDashboardTick(p,host);},1000);
}
function updateDashboardTick(p,host) {
 const now=new Date();
 const zones={"clockUganda":"Africa/Kampala","clockDubai":"Asia/Dubai","clockItaly":"Europe/Rome"};
 for(const [id,zone] of Object.entries(zones)){const el=host.querySelector("#"+id);if(el)el.textContent=formatClock(now,zone);}
 const boundsStart=p.contractStart?zonedDateTime(...p.contractStart.split("-").map(Number),0,0,0,"Asia/Dubai"):null;
 let boundsEnd=null;if(p.contractEnd){const [y,m,d]=p.contractEnd.split("-").map(Number);boundsEnd=zonedDateTime(y,m,d+1,0,0,0,"Asia/Dubai");}
 const daysEl=host.querySelector("#daysRemaining"),status=host.querySelector("#contractStatus"),progress=host.querySelector("#progress"),contractDates=host.querySelector("#contractDates");
 if(daysEl&&boundsStart&&boundsEnd) {
  daysEl.textContent=now<boundsStart?Math.ceil((boundsStart-now)/86400000)+" days to start":now>=boundsEnd?"0 days":Math.ceil((boundsEnd-now)/86400000)+" days";
  status.textContent=now<boundsStart?"Not started":now>=boundsEnd?"Contract ended":"Until "+dateLabel(new Date(boundsEnd.getTime()-1),p.displayZone);
  if(progress)progress.textContent=Math.round(Math.min(100,Math.max(0,(now-boundsStart)/(boundsEnd-boundsStart)*100)))+"%";
  if(contractDates)contractDates.textContent="Contract dates (Dubai-local dates, shown in "+TZ_NAMES[p.displayZone]+" time): "+dateLabel(boundsStart,p.displayZone)+" – "+dateLabel(new Date(boundsEnd.getTime()-1),p.displayZone);
 } else if(daysEl){daysEl.textContent="Not set";if(status)status.textContent="Add contract dates";}
 const dateInput=host.querySelector("#shiftDate");if(!dateInput||!dateInput.value)return;
 const date=dateInput.value,s=p.schedules[date],count=host.querySelector("#shiftCountdown"),shiftStatus=host.querySelector("#shiftStatus"),hoursTitle=host.querySelector("#shiftHoursTitle");
 if(!s){if(count)count.textContent="Not confirmed";if(shiftStatus)shiftStatus.textContent="Add/verify this date's shift";if(hoursTitle)hoursTitle.textContent="Shift hours (not set)";const val=hoursTitle?.nextElementSibling?.querySelector(".value");const val2=host.querySelector("#shiftHoursTitle + .value");if(val2)val2.textContent="—";const note=host.querySelector("#selectedDateNote");if(note)note.textContent="No shift saved for "+date+". Edit this profile to add the confirmed schedule.";return;}
 const [sy,sm,sd]=date.split("-").map(Number),[sh,smn]=s.start.split(":").map(Number),[eh,emn]=s.end.split(":").map(Number);
 const start=zonedDateTime(sy,sm,sd,sh,smn,0,p.scheduleZone),end=zonedDateTime(sy,sm,sd,eh,emn,0,p.scheduleZone);
 if(count)count.textContent=now<start?fmtDuration(start-now):now<end?fmtDuration(end-now):"Shift window ended";
 if(shiftStatus)shiftStatus.textContent=now<start?"Until shift starts":now<end?"Time until shift ends":"Confirm attendance in Ogram if required";
 if(hoursTitle)hoursTitle.textContent="Shift hours ("+TZ_NAMES[p.displayZone]+")";
 const value=host.querySelector("#shiftHoursTitle + .value");if(value)value.textContent=formatClock(start,p.displayZone)+"–"+formatClock(end,p.displayZone);
 const note=host.querySelector("#selectedDateNote");if(note)note.textContent="Shift date "+date+" · source schedule "+TZ_NAMES[p.scheduleZone]+" · displayed in "+TZ_NAMES[p.displayZone]+".";
}
function restoreConfirmation(p,host) {
 const date=host.querySelector("#shiftDate")?.value;if(!date)return;
 const record=p.confirmations[date],track=host.querySelector("#swipeTrack"),knob=host.querySelector("#swipeKnob"),label=host.querySelector("#swipeLabel"),status=host.querySelector("#endShiftStatus");
 if(!track||!knob||!label||!status)return;
 track.classList.remove("done");knob.style.left="4px";knob.textContent="›";label.textContent="Swipe to confirm finished";status.textContent="";
 if(record) {
  track.classList.add("done");knob.textContent="✓";label.textContent="This shift is self-confirmed";
  requestAnimationFrame(()=>knob.style.left=Math.max(4,track.clientWidth-knob.offsetWidth-4)+"px");
  status.textContent="Self-confirmed "+new Intl.DateTimeFormat("en-GB",{timeZone:record.timezone||p.displayZone,dateStyle:"medium",timeStyle:"medium"}).format(new Date(record.confirmedAt))+". Local only; Ogram unchanged.";
 }
}
function setupSwipe(p,host) {
 const track=host.querySelector("#swipeTrack"),knob=host.querySelector("#swipeKnob"),label=host.querySelector("#swipeLabel"),status=host.querySelector("#endShiftStatus");
 if(!track||!knob||!label||!status)return;
 let dragging=false,startX=0,offset=0,completed=false;
 const max=()=>Math.max(0,track.clientWidth-knob.offsetWidth-8);
 function paint(x){offset=Math.max(0,Math.min(max(),x));knob.style.left=(4+offset)+"px";}
 function load(){const date=host.querySelector("#shiftDate")?.value;completed=!!(date&&p.confirmations[date]);restoreConfirmation(p,host);offset=completed?max():0;}
 function begin(e){if(completed)return;dragging=true;startX=e.clientX;knob.setPointerCapture?.(e.pointerId);}
 function move(e){if(!dragging)return;paint(offset+(e.clientX-startX));startX=e.clientX;if(offset>=max()*0.82){
  completed=true;dragging=false;paint(max());track.classList.add("done");label.textContent="Shift confirmed in this page";knob.textContent="✓";
  const stamp=new Date(),date=host.querySelector("#shiftDate")?.value;
  if(!date||!p.schedules[date]){status.textContent="No confirmed schedule for this date. Add the schedule before confirming.";completed=false;return;}
  p.confirmations[date]={shiftDate:date,confirmedAt:stamp.toISOString(),timezone:p.displayZone};
  status.textContent="Self-confirmed for "+date+" at "+new Intl.DateTimeFormat("en-GB",{timeZone:p.displayZone,dateStyle:"medium",timeStyle:"medium"}).format(stamp)+". Local only; Ogram unchanged.";
  saveStore();
 }}
 function end(){if(!dragging)return;dragging=false;if(!completed){offset=0;knob.style.transition="left .18s ease";paint(0);setTimeout(()=>knob.style.transition="",200);}}
 knob.addEventListener("pointerdown",begin);knob.addEventListener("pointermove",move);knob.addEventListener("pointerup",end);knob.addEventListener("pointercancel",end);
 host.querySelector("#shiftDate")?.addEventListener("change",load);
 window.addEventListener("resize",()=>{if(completed)paint(max());});
 load();
}
function showBackup(){showOnly("backupPanel");}
function downloadJSON(filename,obj) {
 const blob=new Blob([JSON.stringify(obj,null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1200);
}
function exportBackup() {
 downloadJSON("DKASU_Shift_Dashboard_Backup.json",{format:"DKASUShiftDashboardBackup",version:1,exportedAt:new Date().toISOString(),profiles:Object.values(profiles)});
 document.getElementById("backupStatus").textContent="Backup exported. Keep the JSON file private; it contains worker profile details and confirmation timestamps.";
}
async function importBackup(file) {
 const data=JSON.parse(await file.text());
 if(data.format!=="DKASUShiftDashboardBackup"||data.version!==1||!Array.isArray(data.profiles))throw new Error("This is not a supported dashboard backup.");
 const incoming={};
 for(const raw of data.profiles) {
  if(!raw||typeof raw.name!=="string"||typeof raw.id!=="string")throw new Error("Invalid profile in backup.");
  const p=normalizeProfile(raw);
  for(const [date,s] of Object.entries(p.schedules))if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(s.start)||!/^\d{2}:\d{2}$/.test(s.end))throw new Error("Invalid shift schedule in backup.");
  incoming[p.id]=p;
 }
 if(!Object.keys(incoming).length)throw new Error("Backup has no profiles.");
 if(!confirm("Restore "+Object.keys(incoming).length+" profiles? This replaces all current profiles on this device."))return;
 profiles=incoming;activeProfileId=null;saveStore();renderProfileList();showOnly("profilePicker");
 document.getElementById("backupStatus").textContent="Backup restored successfully.";
}
document.getElementById("addProfileButton").addEventListener("click",startAdd);
document.getElementById("addTopButton").addEventListener("click",startAdd);
document.getElementById("profilesTopButton").addEventListener("click",()=>{renderProfileList();showOnly("profilePicker");});
document.getElementById("cancelEditorButton").addEventListener("click",()=>{renderProfileList();showOnly("profilePicker");});
document.getElementById("saveProfileButton").addEventListener("click",saveEditor);
document.getElementById("switchProfileButton").addEventListener("click",()=>{renderProfileList();showOnly("profilePicker");});
document.getElementById("editActiveButton").addEventListener("click",startEdit);
document.getElementById("deleteActiveButton").addEventListener("click",deleteActive);
document.getElementById("backupButton").addEventListener("click",showBackup);
document.getElementById("backFromBackupButton").addEventListener("click",()=>{renderProfileList();showOnly("profilePicker");});
document.getElementById("exportBackupButton").addEventListener("click",()=>{try{exportBackup();}catch(e){document.getElementById("backupStatus").textContent="Export failed in this viewer. Open the installed app in Chrome and retry.";}});
document.getElementById("importBackupButton").addEventListener("click",()=>document.getElementById("backupFileInput").click());
document.getElementById("backupFileInput").addEventListener("change",async e=>{if(!e.target.files?.[0])return;try{await importBackup(e.target.files[0]);}catch(err){document.getElementById("backupStatus").textContent="Restore failed: "+err.message;}finally{e.target.value="";}});
if("serviceWorker" in navigator&&location.protocol!=="file:")window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(()=>{document.getElementById("storageStatus").textContent="Offline caching unavailable in this browser."}));
(async()=>{const s=document.getElementById("storageStatus");try{if(navigator.storage?.persist){const granted=(await navigator.storage.persisted())||await navigator.storage.persist();s.textContent=granted?"Persistent storage protection is enabled. Export backups as extra protection.":"Browser did not grant persistent-storage protection; export backups regularly.";}else s.textContent="Persistent storage protection is unavailable in this browser; export backups regularly."}catch(_){s.textContent="Could not verify storage protection; export backups regularly."}})();

loadStore();
renderProfileList();
const last=localStorage.getItem(ACTIVE_KEY);
if(last&&profiles[last])openProfile(last);else showOnly("profilePicker");
