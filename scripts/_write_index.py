import os

HTML_HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Dream Journal Orion by Lantern OS</title>
<link rel="stylesheet" href="dream-journal.css?v=20260602-orion-v1">
<style>
.container{max-width:1100px;margin:0 auto;padding:0 20px}
.message{padding:1rem;border-radius:8px;margin-bottom:1.5rem;font-size:.95rem;display:none}
.message.success{background:rgba(105,180,120,.12);color:#4a7d5c;border-left:4px solid #69b478}
.message.error{background:rgba(198,40,40,.12);color:#8b3a3a;border-left:4px solid #c62828}
.bubble img,.bubble-image{max-width:100%;border-radius:12px;margin-top:.5rem}
.bubble-wrapper{margin-bottom:.8rem}
.bubble-label{font-size:.7rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.2rem;margin-left:.5rem}
.bubble-caption{font-size:.8rem;color:var(--text-muted);margin-top:.3rem;font-style:italic}
.door-card{background:linear-gradient(135deg,var(--celestial-faint),var(--dream-mist));border-radius:var(--radius-md);padding:1rem;margin:.5rem 0;border:1px solid var(--panel-border)}
.door-card img{max-width:100%;border-radius:10px}
.door-card h4{margin:.5rem 0 .3rem;color:var(--celestial-deep)}
.door-card p{margin:0;font-size:.9rem;color:var(--text-secondary)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.cursor{display:inline-block;width:2px;height:.9em;background:var(--celestial-mid);margin-left:1px;vertical-align:text-bottom;animation:blink .9s step-end infinite;border-radius:1px}
.chat-card{border-radius:var(--radius-xl);background:var(--panel-bg);border:1px solid var(--panel-border);overflow:hidden;box-shadow:var(--shadow-soft)}
.chat-header{display:flex;align-items:center;gap:.6rem;padding:12px 18px;background:linear-gradient(135deg,var(--celestial-deep),var(--dream-purple));color:white}
.chat-status{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;margin-left:auto;opacity:.95}
.status-dot{width:9px;height:9px;border-radius:50%;background:#69b478;box-shadow:0 0 0 3px rgba(105,180,120,.3)}
.status-dot.offline{background:var(--lantern-amber);box-shadow:0 0 0 3px rgba(232,145,58,.3)}
.chat-log{padding:16px 18px;max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:.9rem;background:var(--panel-bg-solid)}
.bubble{max-width:85%;padding:10px 14px;border-radius:14px;font-size:.92rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
.bubble.lantern{align-self:flex-start;background:linear-gradient(135deg,var(--celestial-faint),var(--dream-mist));color:var(--celestial-ink);border-bottom-left-radius:4px}
.bubble.operator{align-self:flex-end;background:linear-gradient(135deg,var(--lantern-amber),var(--lantern-warm));color:white;border-bottom-right-radius:4px}
.bubble.typing{align-self:flex-start;color:var(--text-muted);font-style:italic}
.chat-suggestions{display:flex;flex-wrap:wrap;gap:8px;padding:0 18px 12px}
.chip{background:var(--celestial-faint);color:var(--celestial-deep);border:1px solid var(--panel-border);padding:8px 14px;border-radius:20px;font-size:.85rem;cursor:pointer;transition:all .2s;font-family:inherit;box-shadow:none}
.chip:hover{background:var(--dream-lavender);transform:translateY(-1px)}
.chat-input-row{display:flex;gap:8px;padding:12px 18px 18px;border-top:1px solid var(--panel-border)}
.chat-input-row input{flex:1}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:1.5rem}
.stat-card{padding:18px;border-radius:var(--radius-lg);text-align:center;background:var(--panel-bg);border:1px solid var(--panel-border);box-shadow:var(--shadow-soft);transition:transform .2s}
.stat-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-glow)}
.stat-number{font-size:2rem;font-weight:800;background:linear-gradient(135deg,var(--star-gold),var(--star-warm));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:6px}
.stat-label{font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.form-group{margin-bottom:18px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:640px){.form-row{grid-template-columns:1fr}}
.entries{display:flex;flex-direction:column;gap:12px}
.entry{padding:16px;border-radius:var(--radius-md);background:var(--panel-bg-solid);border:1px solid var(--panel-border);border-left:3px solid var(--lantern-amber);box-shadow:var(--shadow-soft);transition:box-shadow .2s}
.entry:hover{box-shadow:var(--shadow-glow)}
.entry-meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:.8rem}
.entry .entry-kind{background:var(--celestial-faint);color:var(--celestial-deep);padding:3px 10px;border-radius:6px;font-size:.72rem;font-weight:700}
.entry .entry-time{color:var(--text-muted)}
.entry-text{color:var(--text-secondary);margin-bottom:8px;line-height:1.5}
.entry .entry-tags{display:flex;flex-wrap:wrap;gap:6px;font-size:.78rem}
.tag{background:var(--celestial-faint);color:var(--dream-purple);padding:3px 10px;border-radius:6px;border:1px solid var(--panel-border);font-size:.75rem}
.empty-state{text-align:center;color:var(--text-muted);padding:32px 16px;background:linear-gradient(135deg,var(--celestial-faint),var(--dream-mist));border-radius:var(--radius-md);border:2px dashed var(--panel-border)}
.footer-note{margin-top:12px;padding:14px;background:var(--panel-bg);border-radius:var(--radius-md);border:1px solid var(--panel-border);color:var(--text-secondary);font-size:.85rem}
.footer-note strong{color:var(--celestial-deep)}
#outreach-section{margin-top:24px;padding:16px 20px;background:var(--panel-bg);border-radius:var(--radius-lg);border:1px solid var(--panel-border)}
#outreach-section h2{font-size:1rem;margin-bottom:8px;color:var(--celestial-ink);font-family:'Cormorant Garamond',Georgia,serif}
#outreach-section a{color:var(--dream-purple);font-weight:700}
#outreach-section p{color:var(--text-muted);font-size:.85rem;margin-bottom:4px}
#refresh{background:linear-gradient(135deg,var(--celestial-deep),var(--dream-purple));color:white;border:none;padding:12px 24px;border-radius:var(--radius-md);font-weight:700;cursor:pointer;transition:transform .15s;box-shadow:0 4px 16px rgba(74,63,122,.3)}
#refresh:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(74,63,122,.4)}
#chatPanel{margin-top:20px}
#chatSend{padding:10px 20px;border:none;border-radius:100px;background:linear-gradient(135deg,var(--celestial-deep),var(--dream-purple));color:white;font:inherit;font-weight:700;cursor:pointer;transition:transform .15s}
#chatSend:hover{transform:scale(1.05)}
#chatClear{background:var(--celestial-faint)!important;color:var(--text-muted)!important;padding:10px 16px!important;border:none;border-radius:100px;font:inherit;cursor:pointer}
.chat-input-row input{padding:10px 14px;border:1px solid var(--panel-border);border-radius:100px;background:white;font:inherit;font-size:.9rem}
.chat-input-row input:focus{outline:none;border-color:var(--dream-purple);box-shadow:0 0 0 3px rgba(139,126,200,.12)}
textarea,input[type="text"],input[type="number"],select{width:100%;padding:10px 14px;border:1px solid var(--panel-border);border-radius:var(--radius-md);background:var(--panel-bg-solid);color:var(--text-primary);font:inherit;font-size:.92rem;transition:border-color .2s,box-shadow .2s}
textarea{min-height:120px;resize:vertical}
textarea:focus,input:focus,select:focus{outline:none;border-color:var(--dream-purple);box-shadow:0 0 0 3px rgba(139,126,200,.15)}
label{display:block;margin-bottom:6px;color:var(--text-secondary);font-size:.82rem;font-weight:600}
#entryForm button[type="submit"]{width:auto;margin-top:8px;padding:12px 28px;border:none;border-radius:var(--radius-md);background:linear-gradient(135deg,var(--celestial-deep),var(--dream-purple));color:white;font:inherit;font-size:.95rem;font-weight:700;cursor:pointer;transition:transform .15s;box-shadow:0 4px 16px rgba(74,63,122,.3)}
#entryForm button[type="submit"]:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(74,63,122,.4)}
</style>
</head>
<body>
<div class="dream-shell">
<header class="dream-hero">
<div class="hero-icon" aria-hidden="true">
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
</div>
<p class="eyebrow">Lantern OS</p>
<h1>Dream Journal</h1>
<p class="byline">Orion Edition</p>
<p class="tagline">Remember your dreams.<br>Reflect on what they mean.</p>
<p class="subtagline">A private dream-journaling space with guided prompts, saved notes, notebook recall, and a Discord companion.</p>
<div class="privacy-badge" role="img" aria-label="Privacy shield">
<svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
<span>Your dreams. Your space. Always private.</span>
</div>
<nav class="dream-nav" aria-label="Dreamer sections">
<a href="/" aria-current="page">Journal</a>
<a href="/courtney.html">The Well</a>
<a href="/wish-door.html">Wish Door</a>
</nav>
</header>
<section class="features-strip" aria-label="Features">
<article class="feature-card"><div class="icon">&#128211;</div><h3>Save Dreams</h3><p>Capture dreams before they fade.</p></article>
<article class="feature-card"><div class="icon">&#128172;</div><h3>Follow Prompts</h3><p>Guided questions to help you reflect.</p></article>
<article class="feature-card"><div class="icon">&#128220;</div><h3>Revisit Patterns</h3><p>Find meaning in your memories over time.</p></article>
<article class="feature-card"><div class="icon">&#128126;</div><h3>Discord Companion</h3><p>Journal inside our community and keep your dreams alive.</p></article>
<article class="feature-card"><div class="icon">&#128682;</div><h3>ImaginVerses</h3><p>Step through doors to new worlds you build with friends.</p></article>
</section>
<div class="container">
<div id="message"></div>
<section id="chat-section">
<div class="dream-panel" id="chatPanel">
<div class="panel-header"><h2>Talk to your Dream Journal</h2><p class="panel-desc">Local, private, always here even offline.</p></div>
<div class="chat-card">
<div class="chat-header"><span>&#127769;</span><strong>Dream Journal</strong><span class="chat-status"><span class="status-dot" id="statusDot"></span><span id="statusText">Online</span></span></div>
<div class="chat-log" id="chatLog"></div>
<div class="chat-suggestions" id="chatSuggestions"></div>
<div class="chat-input-row"><input type="text" id="chatInput" placeholder="Tell me a dream, a door, or a feeling..." autocomplete="off"><button id="chatSend" type="button">Send</button><button id="chatClear" type="button" title="Clear chat memory">Clear</button></div>
</div>
</div>
</section>
<section id="outreach-section"><h2>Outreach Program</h2><p><a href="/outreach.html">Outreach Program</a></p><p>20260530-kalshi-packet</p><p><a href="/view?path=docs/ARC-REACTOR-MINING-LAB.md">Mining lab notes</a> (solo-mining skill archived)</p></section>
<section aria-label="Primary controls"><button type="button" id="refresh">Refresh</button></section>
<section id="stats-section">
<div class="dream-panel">
<div class="panel-header"><h2>Your Journal</h2><p class="panel-desc">Cloud tunnel ready. Current Model: Baseline v1.</p></div>
<div class="panel-body">
<div class="stats">
<div class="stat-card"><div class="stat-number" id="totalCount">0</div><div class="stat-label">Total Entries</div></div>
<div class="stat-card"><div class="stat-number" id="dreamCount">0</div><div class="stat-label">Dreams</div></div>
<div class="stat-card"><div class="stat-number" id="noteCount">0</div><div class="stat-label">Notes</div></div>
<div class="stat-card"><div class="stat-number" id="avgLucidity">--</div><div class="stat-label">Avg Lucidity</div></div>
</div>
</div>
</div>
</section>
<section id="form-section">
<div class="dream-panel">
<div class="panel-header"><h2>New Entry</h2><p class="panel-desc">What do you want to remember?</p></div>
<div class="panel-body">
<form id="entryForm">
<div class="form-group"><label for="text">What do you want to remember?</label><textarea id="text" name="text" placeholder="Write freely. What was vivid? What mattered? What surprised you?" required></textarea></div>
<div class="form-row">
<div class="form-group"><label for="emotions">Emotions (comma-separated)</label><input type="text" id="emotions" name="emotions" placeholder="e.g., clarity, wonder, peace, curiosity"></div>
<div class="form-group"><label for="lucidity">Lucidity (0 = asleep, 1 = awake)</label><input type="number" id="lucidity" name="lucidity" min="0" max="1" step="0.1" value="0.5"></div>
</div>
<div class="form-group"><label for="tags">Tags (comma-separated)</label><input type="text" id="tags" name="tags" placeholder="e.g., lantern, learning, home, family"></div>
<button type="submit">Save Entry</button>
</form>
</div>
</div>
</section>
<section id="entries-section">
<div class="dream-panel">
<div class="panel-header"><h2>Recent Entries</h2><p class="panel-desc">Your entries are saved locally in your journal.</p></div>
<div class="panel-body"><div class="entries" id="entriesList"></div></div>
</div>
</section>
<footer class="dream-footer">
<p>Dream Journal Orion &mdash; CSF v0.7 Symbolic Qutrit Edition</p>
<p class="creator">Created by Alex Place</p>
<div class="footer-note"><strong>Lantern Principle:</strong> Visible enough to trust. Small enough not to burn the house down.</div>
</footer>
</div>
</div>
<script>
'''

JS = '''const API={create:async d=>{const r=await fetch('/api/dream/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error(await r.text());return r.json()},stats:async()=>{const r=await fetch('/api/dream/stats');if(!r.ok)throw new Error(await r.text());return r.json()}};
function showMessage(t,ty='success'){const el=document.getElementById('message');el.className='message '+ty;el.textContent=t;el.style.display='block';if(ty==='success')setTimeout(()=>el.style.display='none',3000)}
function renderEntries(s){if(!s||s.total_entries===0){document.getElementById('entriesList').innerHTML='<div class="empty-state">&#10024; No entries yet.<br>Start with your first dream or note.</div>';return}document.getElementById('entriesList').innerHTML='<p style="color:var(--text-muted);text-align:center">Your entries are saved locally in your journal.</p>'}
async function loadStats(){try{const s=await API.stats();document.getElementById('totalCount').textContent=s.total_entries||0;document.getElementById('dreamCount').textContent=s.entries_by_kind?.dream||0;document.getElementById('noteCount').textContent=s.entries_by_kind?.note||0;const avg=s.avg_lucidity?parseFloat(s.avg_lucidity).toFixed(2):'--';document.getElementById('avgLucidity').textContent=avg;renderEntries(s)}catch(e){console.error('Failed to load stats:',e)}}
document.getElementById('entryForm').addEventListener('submit',async e=>{e.preventDefault();try{const emotions=document.getElementById('emotions').value.split(',').map(s=>s.trim()).filter(Boolean);const tags=document.getElementById('tags').value.split(',').map(s=>s.trim()).filter(Boolean);const data={kind:'dream',text:document.getElementById('text').value,emotions,tags,lucidity:parseFloat(document.getElementById('lucidity').value)||0.5};await API.create(data);showMessage('&#10003; Entry saved to your journal');document.getElementById('entryForm').reset();document.getElementById('lucidity').value=0.5;await loadStats()}catch(err){showMessage('Error: '+err.message,'error')}});
const DOORS=[{id:"xenon",name:"Xenon Door",tagline:"Gateway to Forever",image:"/images/doors/xenon-door.jpg",phrase:"Build beyond one world.",keywords:["xenon","courtney","shelby","planetary","alignment","gateway","forever","stars"]},{id:"garden",name:"God's Garden Door",tagline:"Sea of Fog and Clouds",image:"/images/doors/garden-door.jpg",phrase:"Leave it better than you found it.",keywords:["garden","god","fog","clouds","sanctuary","peace","rest","odin"]},{id:"xp",name:"Gage's Windows XP Door",tagline:"Chaos. Creativity. Nostalgia. Possibilities.",image:"/images/doors/xp-door.jpg",phrase:"Never log off. Level up always.",keywords:["xp","windows","gage","childhood","chaos","creativity","nostalgia","pixels"]},{id:"hearts",name:"Kingdom of Hearts",tagline:"I am the King of the Kingdom of Hearts.",image:"/images/doors/kingdom-of-hearts.jpg",phrase:"I fight for the love of all the birds and the bees.",keywords:["hearts","kingdom","king","odin","love","birds","bees","courage"]},{id:"founder",name:"Founder's Wish Door",tagline:"Hold the center. Protect the wish. Return to the anchor.",image:"/images/doors/founder-door.jpg",phrase:"Hold the center. Protect the wish. Return to the anchor.",keywords:["founder","wish","anchor","love","safety","truth","return"]},{id:"sigil",name:"Sigil / City of Doors",tagline:"You hold the keys. You protect the doors. You are never alone.",image:"/images/doors/sigil-door.jpg",phrase:"You hold the keys. You protect the doors. You are never alone.",keywords:["sigil","city","doors","keys","community","alone"]},{id:"orion",name:"Orion Dream Journal",tagline:"Every dream is a door. Every memory is a home.",image:"/images/doors/orion-door.jpg",phrase:"Your dreams. Your space. Always private.",keywords:["orion","journal","dream","record","reflect","private"]}];
let lastDraft="";
function setStatus(on,name){const dot=document.getElementById('statusDot'),txt=document.getElementById('statusText');if(name){dot.className='status-dot';txt.textContent=name+(on?'':' (local)')}else{dot.className='status-dot'+(on?'':' offline');txt.textContent=on?'Online':'Offline (local)'}}
function addBubble(role,text){const log=document.getElementById('chatLog');const b=document.createElement('div');b.className='bubble '+role;b.textContent=text;log.appendChild(b);log.scrollTop=log.scrollHeight;saveChatMemory();return b}
function addImageBubble(role,src,cap){const log=document.getElementById('chatLog');const b=document.createElement('div');b.className='bubble '+role;const img=document.createElement('img');img.src=src;img.alt=cap||'';img.onerror=()=>{img.style.display='none'};b.appendChild(img);if(cap){const c=document.createElement('div');c.className='bubble-caption';c.textContent=cap;b.appendChild(c)}log.appendChild(b);log.scrollTop=log.scrollHeight;saveChatMemory();return b}
const CHAT_KEY='lantern_chat_memory_v1';
function saveChatMemory(){const log=document.getElementById('chatLog'),ent=[];log.querySelectorAll('.bubble').forEach(b=>{const img=b.querySelector('img');ent.push({role:b.classList.contains('operator')?'operator':'lantern',text:b.childNodes[0]?.textContent||'',image:img?img.src:null,caption:img?b.querySelector('.bubble-caption')?.textContent:null})});localStorage.setItem(CHAT_KEY,JSON.stringify(ent.slice(-100)))}
function loadChatMemory(){try{const raw=localStorage.getItem(CHAT_KEY);if(!raw)return false;const ent=JSON.parse(raw);if(!ent.length)return false;const log=document.getElementById('chatLog');log.innerHTML='';ent.forEach(e=>{if(e.image)addImageBubble(e.role,e.image,e.caption);else addBubble(e.role,e.text)});return true}catch{return false}}
function renderSuggestions(sug){const box=document.getElementById('chatSuggestions');box.innerHTML='';(sug||[]).forEach(s=>{const chip=document.createElement('button');chip.className='chip';chip.type='button';chip.textContent=s;chip.addEventListener('click',()=>handleSuggestion(s));box.appendChild(chip)})}
function offlineReply(msg){const t=(msg||'').trim(),l=t.toLowerCase();const base=["Log a dream","Recent dreams","Mirror a dream","Tell me about the doors"];let agent='Dream Journal';const scores=[{name:'Blinkbug',score:0,keywords:['light','glow','guide','small','warm','bug','firefly']},{name:'Mary / Waterfall',score:0,keywords:['flow','water','mary','heal','gentle','emotion','feeling']},{name:'Courtney / Xenon',score:0,keywords:['space','ship','navigate','courtney','map','course','direction']},{name:'Keystone',score:0,keywords:['anchor','memory','story','foundation','hold','remember']},{name:'Founder / Alex',score:0,keywords:['wish','protect','founder','alex','home','return','safety']}];for(const a of scores){for(const kw of a.keywords)if(l.includes(kw))a.score+=10;a.score+=Math.random()*3}scores.sort((a,b)=>b.score-a.score);agent=scores[0].name;for(const d of DOORS){if(d.keywords.some(k=>l.includes(k)))return{reply:d.name+' stands open. "'+d.phrase+'" What do you see when you step through?',image:d.image,caption:d.name+' '+d.tagline,suggestions:["Log this as a dream","Another door","Mirror a dream"],agent}}if(l.includes('doors')||l.includes('all doors')||l.includes('which doors')){const list=DOORS.map(d=>d.name+' '+d.tagline).join('<br>');return{reply:'These doors stand open:<br><br>'+list+'<br><br>Which one calls to you?',suggestions:["Xenon Door","Garden Door","XP Door","Kingdom of Hearts"],agent}}if(/^(hi|hello|hey|good (morning|evening|night)|greetings)/.test(l))return{reply:"Welcome back. I am the Dream Journal local, private, always here, even offline. Did you dream?",suggestions:base,agent};if(l.includes('mirror')||l.includes('interpret')||l.includes('mean')||l.includes('symbol'))return{reply:"Sit with three questions: 1) What feeling stayed after waking? 2) What in waking life does this echo? 3) What small, reversible step would honor it?",suggestions:["Record a reflection","Recent dreams"],agent};if(l.includes('recent')||l.includes('history'))return{reply:"Open the journal below to see your saved entries. Want to mirror one?",suggestions:["Mirror a dream","Log a dream"],agent};if(l.includes('log')||l.includes('dream')||l.includes('save'))return{reply:"Good let us keep it. Tell me the dream in your own words. I will save it locally; only you can see it.",suggestions:["Recent dreams","Mirror a dream"],agent};return{reply:'I hear it: "'+t.slice(0,160)+'". That is worth keeping. Tap "Log this as a dream" to save it.',suggestions:["Log this as a dream","Mirror a dream","Tell me about the doors"],draft:t,agent}}
function escapeHtml(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function makeBubble(role,label){const log=document.getElementById('chatLog');const w=document.createElement('div');w.className='bubble-wrapper '+role;if(label){const n=document.createElement('div');n.className='bubble-label';n.textContent=label;w.appendChild(n)}const b=document.createElement('div');b.className='bubble '+role;w.appendChild(b);log.appendChild(w);log.scrollTop=log.scrollHeight;return b}
async function streamOffline(text,suggestions,image,caption,agentLabel){if(image)addImageBubble('lantern',image,caption);setStatus(false,agentLabel||'Dream Journal');const b=makeBubble('lantern',agentLabel||'Dream Journal');b.innerHTML='<span class="cursor"></span>';const log=document.getElementById('chatLog');const tokens=text.split(/(\s+)/);let out='';for(const tok of tokens){if(!tok)continue;out+=tok;const isPunct=/[.!?,;:]$/.test(tok.trim());b.innerHTML=escapeHtml(out)+'<span class="cursor"></span>';log.scrollTop=log.scrollHeight;await new Promise(r=>setTimeout(r,isPunct?60+Math.random()*80:18+Math.random()*28))}b.textContent=out;renderSuggestions(suggestions);return b}
async function sendChat(message){const msg=(message||'').trim();if(!msg)return;const inp=document.getElementById('chatInput'),snd=document.getElementById('chatSend');inp.disabled=true;snd.disabled=true;addBubble('operator',msg);renderSuggestions([]);const log=document.getElementById('chatLog');let currentAgent='Dream Journal';const b=makeBubble('lantern',currentAgent+' is typing...');b.innerHTML='<span class="cursor"></span>';try{const res=await fetch('/api/dream/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});if(!res.ok)throw new Error('stream_failed');setStatus(true);const reader=res.body.getReader(),decoder=new TextDecoder();let buf='',out='',suggestions=[];while(true){const{done,value}=await reader.read();if(done)break;buf+=decoder.decode(value,{stream:true});const lines=buf.split('\\n');buf=lines.pop();for(const line of lines){if(!line.startsWith('data: '))continue;const raw=line.slice(6).trim();if(raw==='[DONE]')continue;let ev;try{ev=JSON.parse(raw)}catch{continue}if(ev.type==='token'){out+=ev.text;b.innerHTML=escapeHtml(out)+'<span class="cursor"></span>';log.scrollTop=log.scrollHeight}else if(ev.type==='done'){suggestions=ev.suggestions||[];if(ev.draft)lastDraft=ev.draft;if(ev.online!==undefined)setStatus(ev.online,ev.agent);if(ev.agent){currentAgent=ev.agent;const wrapper=b.parentElement;if(wrapper){const label=wrapper.querySelector('.bubble-label');if(label)label.textContent=currentAgent}}}}}}b.textContent=out;renderSuggestions(suggestions)}catch(_){b.remove();const local=offlineReply(msg);await streamOffline(local.reply,local.suggestions,local.image,local.caption,local.agent||'Dream Journal');if(local.draft)lastDraft=local.draft||msg}finally{inp.disabled=false;snd.disabled=false;inp.focus()}}
async function handleSuggestion(label){const l=label.toLowerCase();if(l.includes('log')){if(lastDraft)document.getElementById('text').value=lastDraft;document.getElementById('form-section').scrollIntoView({behavior:'smooth'});addBubble('lantern','I moved your words to the New Entry form below. Add tags and emotions, then Save Entry.');return}if(l.includes('recent')){document.getElementById('stats-section').scrollIntoView({behavior:'smooth'})}sendChat(label)}
document.getElementById('chatSend').addEventListener('click',()=>{const inp=document.getElementById('chatInput');const msg=inp.value;inp.value='';sendChat(msg)});
document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('chatSend').click()}});
document.getElementById('chatClear').addEventListener('click',()=>{localStorage.removeItem(CHAT_KEY);document.getElementById('chatLog').innerHTML='';addBubble('lantern','Chat memory cleared. The dream door is open again.')});
if(!loadChatMemory()){addBubble('lantern','The dream door is open. What did you bring back? Tell me a dream, or tap a prompt below.');renderSuggestions(["Log a dream","Recent dreams","Mirror a dream","Tell me about the doors"])}
loadStats();
setInterval(loadStats,10000);
</script>
</body>
</html>
'''

out = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '..', 'apps', 'lantern-garage', 'public', 'index.html'))
with open(out, 'w', encoding='utf-8') as f:
    f.write(HTML_HEAD + JS)
print('Wrote', out, len(HTML_HEAD)+len(JS), 'bytes')
