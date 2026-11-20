const home = "https://scholar.google.com/scholar_labs/search";
const $ = id => document.getElementById(id);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = msg => { $("status").textContent = msg; };
let stopped = false;
function check() { if (stopped) throw Error("Coda in pausa."); }
async function inTab(id, func, ...args) {
  check();
  const [result] = await chrome.scripting.executeScript({target:{tabId:id},func,args});
  return result.result;
}
// Runs inside Scholar. Keep the observed text separate from input and navigation.
function inspect(query, submit, follow) {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const body = document.body?.innerText || "";
  if (/\/sorry\//.test(location.pathname) || /unusual traffic|traffico insolito|too many requests|troppe richieste|non sono un robot|verify you are human/i.test(body) ||
      [...document.querySelectorAll('iframe[src*="recaptcha"][title*="reCAPTCHA"]')].some(visible))
    return {blocked:true};
  const root = [...document.querySelectorAll('main,[role="main"]')].find(visible) || document.body;
  if (!root) return {};
  const text = root.innerText.trim();
  const boxes = [...document.querySelectorAll('textarea,input[type="text"],input[type="search"],[role="textbox"]')].filter(el => visible(el) && !el.disabled && !el.readOnly && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName)));
  const box = follow ? boxes.at(-1) : boxes[0];
  if (submit && box) {
    box.focus();
    if (box.isContentEditable) box.textContent = query;
    else {
      const proto = box.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,"value").set.call(box, query);
    }
    box.dispatchEvent(new Event("input",{bubbles:true}));
    box.dispatchEvent(new Event("change",{bubbles:true}));
    const form = box.closest("form");
    const buttons = [...(form || box.parentElement).querySelectorAll('button,input[type="submit"],[role="button"]')].filter(el=>visible(el) && !el.disabled);
    const button = buttons.find(el => /search|cerca|submit|invia|send|ask/i.test([el.innerText,el.title,el.getAttribute("aria-label"),el.value].join(" "))) ||
      buttons.find(el=>el.type === "submit");
    if (button) button.click();
    else if (form) form.requestSubmit();
    else return {text,manual:true};
  }
  const links = [...root.querySelectorAll("a[href]")].filter(visible).filter(a=>/^https?:$/.test(a.protocol))
    .map(a=>({url:a.href,title:a.innerText.trim()})).filter(a=>a.title);
  const busy = [...root.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible);
  return {text,links,busy,ready:!!box};
}
function novelLines(text, baseline, query) {
  const known = new Set([...baseline.split("\n"),query].map(s=>s.trim()));
  return text.split("\n").filter(s=>!s.trim() || !known.has(s.trim())).join("\n").trim();
}
function tasksFrom(raw) {
  raw = raw.trim();
  if (!raw) return [];
  const plain = !/^[\[{]/.test(raw);
  const rows = plain ? [...new Set(raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))].map(query=>({query})) : JSON.parse(raw);
  if (!Array.isArray(rows)) throw Error("Usa un array JSON di domande.");
  const seen = new Set();
  return rows.map((row,index)=>{
    const query = row?.query;
    if (typeof query !== "string" || !query.trim()) throw Error("Domanda mancante alla posizione " + (index+1));
    if (seen.has(query.trim())) throw Error("Domanda duplicata alla posizione " + (index+1));
    seen.add(query.trim());
    function strings(key) {
      const values = row[key] === undefined ? [] : row[key];
      if (!Array.isArray(values) || values.some(v=>typeof v !== "string" || !v.trim()))
        throw Error(key + " deve contenere un elenco di testi non vuoti.");
      return values.map(v=>v.trim());
    }
    return {id:row.id || "Q"+(index+1),query:query.trim(),keywords:strings("trigger_keywords"),follow:strings("follow_ups")};
  });
}
function wanted(task,record) {
  if (!record) return [];
  const lower = record.text.toLowerCase();
  return !task.keywords.length || task.keywords.some(k=>lower.includes(k.toLowerCase())) ? task.follow : [];
}
function refused(turn) {
  return turn?.status==="unsupported" || /scholar labs is currently not designed for queries like this/i.test(turn?.text || "");
}
function completed(task,record) {
  return !!record && !refused(record) && wanted(task,record).every((q,i)=>record.followUps?.[i]?.query===q && !refused(record.followUps[i]));
}
async function snapshot(id,query,follow) {
  const tab=await chrome.tabs.get(id);
  if (tab.url?.startsWith("https://accounts.google.com/")) {
    status("Completa l’accesso e torna a Scholar Labs nella scheda dedicata.");
    return {};
  }
  if (tab.status!=="complete") return {};
  if (!tab.url?.startsWith("https://scholar.google.com/")) throw Error("Torna a Scholar Labs nella scheda dedicata.");
  const snap=await inTab(id,inspect,query,false,follow);
  if (snap.blocked) throw Error("Verifica o limite di Google. Controlla la scheda Scholar prima di riprendere.");
  return snap;
}
async function ask(id,query,follow) {
  let before;
  for (let i=0;i<90;i++) {
    await pause(1000); check();
    before=await snapshot(id,query,follow);
    if (before.ready) break;
  }
  if (!before.ready) throw Error("Campo di ricerca non disponibile.");
  const sent=await inTab(id,inspect,query,true,follow);
  if (!sent.ready && !sent.manual) throw Error("Invio interrotto.");
  status(sent.manual ? "Premi Invio nella scheda Scholar per inviare la domanda." : "In corso · "+query);
  let last="", changed=0;
  for (let i=0;i<180;i++) {
    await pause(1000); check();
    const snap=await snapshot(id,query,follow);
    if (!snap.text) continue;
    const text=novelLines(snap.text,before.text,query);
    if (refused({text})) return {query,status:"unsupported",text:"",links:[]};
    const links=snap.links.filter(a=>!before.links.some(b=>a.url===b.url && a.title===b.title));
    const signature=JSON.stringify([text,links]);
    if (signature!==last || snap.busy) { last=signature; changed=Date.now(); }
    if (text.length >= (follow ? 1 : 120) && (follow || links.length) && !snap.busy && Date.now()-changed>=8000)
      return {query,text,links};
  }
  throw Error("Tempo di attesa esaurito. Controlla la risposta nella scheda Scholar.");
}
async function run() {
  const tasks=tasksFrom($("queries").value);
  if (!tasks.length) throw Error("Inserisci almeno una domanda.");
  const data=await chrome.storage.local.get(["results","worker"]);
  const results=data.results || [];
  const pending=tasks.filter(t=>!completed(t,results.find(r=>r.query===t.query)));
  if (!pending.length) return status("Tutte le domande e gli approfondimenti richiesti sono già salvati.");
  let tab;
  if (data.worker) {
    try {tab=await chrome.tabs.get(data.worker);} catch {}
  }
  const rejected=[];
  for (const task of pending) {
    check();
    const index=results.findIndex(r=>r.query===task.query);
    if (index>=0 && !confirm("Per ricostruire il contesto di "+task.id+" occorre ripetere la ricerca e i relativi follow-up. Continuare?"))
      throw Error("Ripresa annullata.");
    if (!tab?.url?.startsWith("https://scholar.google.com/")) {
      tab=await chrome.tabs.create({url:home,active:true});
      await chrome.storage.local.set({worker:tab.id});
    } else tab=await chrome.tabs.update(tab.id,{url:home});
    status(task.id+" · Apertura nuova ricerca…");
    const main=await ask(tab.id,task.query,false);
    const record={...main,followUps:[]};
    // Keep the previous partial export until the reconstructed thread catches up.
    const previous=index<0 ? null : results[index];
    const follow=refused(main) ? [] : wanted(task,record);
    if (refused(main)) rejected.push(task.id);
    async function saveTurn() {
      if (record.followUps.length<follow.length && record.followUps.length<(previous?.followUps?.length || 0)) return;
      if (index<0 && !results.includes(record)) results.push(record);
      else if (index>=0) results[index]=record;
      await chrome.storage.local.set({results});
    }
    if (!refused(main) || !previous || refused(previous)) await saveTurn();
    for (const question of follow) {
      const answer=await ask(tab.id,question,true);
      record.followUps.push(answer);
      await saveTurn();
      if (refused(answer)) { rejected.push(task.id); break; }
    }
    if (task!==pending.at(-1)) for(let i=0;i<12;i++){check();await pause(1000);}
  }
  status(rejected.length ? "Coda terminata. Domande rifiutate da Labs in "+rejected.join(", ")+". Riformula prima di riprendere." : "Ricerca completata. Puoi scaricare il Markdown.");
}
const guarded=fn=>async(...args)=>{
  try { await fn(...args); } catch(e) { status(e.message+" I risultati già salvati sono disponibili."); }
};
function exclusive(fn) {
  return navigator.locks.request("scholar-labs-run",{ifAvailable:true},lock=>lock ? fn() : status("Coda attiva in un’altra scheda."));
}
$("start").onclick=guarded(()=>exclusive(async()=>{
  stopped=false;
  const controls=["start","file","clear","queries"];
  controls.forEach(id=>$(id).disabled=true);
  $("stop").disabled=false;
  try {await chrome.storage.local.set({draft:$("queries").value});await run();}
  finally {controls.forEach(id=>$(id).disabled=false);$("stop").disabled=true;}
}));
$("stop").onclick=()=>{stopped=true;status("Pausa richiesta…");};
$("file").onchange=guarded(async e=>{
  const file=e.target.files[0];
  if (!file) return;
  const raw=await file.text();
  const tasks=tasksFrom(raw);
  await chrome.storage.local.set({draft:raw});
  $("queries").value=raw;
  status(tasks.length+" domande caricate.");
});
$("clear").onclick=guarded(()=>exclusive(async()=>{
  if (!confirm("Cancellare tutti i risultati e i follow-up salvati su questo computer?")) return;
  await chrome.storage.local.remove("results");
  status("Risultati cancellati.");
}));
$("save").onclick=guarded(async()=>{
  const {results=[]}=await chrome.storage.local.get("results");
  const blocks=[];
  for (const task of tasksFrom($("queries").value)) {
    const record=results.find(r=>r.query===task.query);
    if (!record) continue;
    blocks.push("## "+task.id+" · "+record.query);
    for (const [i,turn] of [record,...record.followUps || []].entries()) {
      if(i) blocks.push("### Follow-up "+i+" · "+turn.query);
      if (refused(turn)) { blocks.push("_Domanda rifiutata da Scholar Labs._"); continue; }
      blocks.push(turn.text);
      if(turn.links.length) blocks.push("#### Collegamenti",...turn.links.map(a=>"- "+a.title+" — "+a.url));
    }
    if (!completed(task,record)) blocks.push("_Approfondimenti richiesti ancora da completare._");
  }
  if(!blocks.length) return status("Nessuna risposta salvata per queste domande.");
  const url=URL.createObjectURL(new Blob([["# Risultati Scholar Labs",...blocks].join("\n\n")],{type:"text/markdown;charset=utf-8"}));
  const a=document.createElement("a");a.href=url;a.download="risultati_scholar_labs.md";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
});
chrome.storage.local.get("draft").then(({draft})=>{$("queries").value=draft||"";});
