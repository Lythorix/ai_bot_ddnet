const teeworlds = require("teeworlds");
const Groq = require("groq-sdk");

// ================== CONFIG ==================
const config = {
    host: "",
    port: 8304,
    botNick: "Ai_Bot",
    groqKey: "Your_key_here",
    model: "llama-3.3-70b-versatile",
    maxReplyLength: 200,
    replyDelay: 3000,
    partDelay: 2000,
    rconPassword: "",
    rconUsername: "",
    rconEnabled: true,
    adminIPs: ["127.0.0.1"],
    owners: ["Lythorix✔"],
    defaultPrefix: "!",
    defaultMemorySize: 1150,
    maxMemoryLimit: 1500,
    temperature: 0.9,
    maxTokens: 4096,
    serverName: "",
    floodMaxMessages: 4,
    floodTimeWindow: 10000,
    floodMuteSeconds: 299
};

const groq = new Groq({ apiKey: config.groqKey });

let client = null;
let connected = false;
let rconAuthed = false;
let aiEnabled = true;
let chatModEnabled = config.rconEnabled;
let prefix = config.defaultPrefix;
let memoryLimit = config.defaultMemorySize;
let chatMemory = [];
let bannedPlayers = new Set();
let moderators = new Set();
let isProcessing = false;
let messageQueue = [];
const mutedPlayers = new Map();
const playerIpCache = new Map();
const spamKnowledgeBase = new Map();
const spamCache = new Map();

// ====== ADMIN CHECK ======
function isAdminByIp(ip) { return ip && config.adminIPs.includes(ip); }
async function getPlayerIpForAuth(nickname) {
    if (!config.rconEnabled || !rconAuthed) return null;
    if (playerIpCache.has(nickname)) return playerIpCache.get(nickname);
    await rconCommand('show_ips 1'); await new Promise(r => setTimeout(r, 500));
    const lines = await rconCommand('status');
    for (const line of lines) {
        if (line.includes(nickname)) {
            const addrMatch = line.match(/addr[=:\s]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);
            if (addrMatch) { const ip = addrMatch[1]; playerIpCache.set(nickname, ip); return ip; }
            const ipMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
            if (ipMatch) { const ip = ipMatch[1]; playerIpCache.set(nickname, ip); return ip; }
        }
    }
    return null;
}
async function checkAdminAccess(author) {
    if (config.owners.includes(author)) return true;
    const ip = await getPlayerIpForAuth(author);
    if (isAdminByIp(ip)) { if (!config.owners.includes(author)) { config.owners.push(author); } return true; }
    return false;
}

// ====== ANTI-FLOOD ======
const floodTracker = new Map();
function checkFlood(author, text) {
    const now = Date.now();
    if (!floodTracker.has(author)) floodTracker.set(author, { messages: [], warnings: 0, muted: false, muteExpiry: 0 });
    const tracker = floodTracker.get(author);
    if (tracker.muted) { if (now > tracker.muteExpiry) { tracker.muted = false; tracker.warnings = 0; tracker.messages = []; } else return false; }
    tracker.messages = tracker.messages.filter(m => now - m.time < config.floodTimeWindow);
    tracker.messages.push({ text: text.toLowerCase().trim(), time: now });
    if (tracker.messages.filter(m => m.text === text.toLowerCase().trim()).length >= config.floodMaxMessages) { tracker.warnings++; tracker.muted = true; tracker.muteExpiry = now + config.floodMuteSeconds * 1000; tracker.messages = []; return true; }
    return false;
}

// ====== RCON ======
async function rconCommand(cmd) { if (!config.rconEnabled || !client || !rconAuthed) return []; return new Promise((resolve) => { const lines = []; const handler = (line) => lines.push(line); client.rcon.on('rcon_line', handler); try { client.rcon.rcon(cmd); } catch (e) {} setTimeout(() => { client.rcon.removeListener('rcon_line', handler); resolve(lines); }, 1000); }); }
async function getPlayerId(nickname) { if (!config.rconEnabled) return null; await rconCommand('show_ips 1'); await new Promise(r => setTimeout(r, 300)); const lines = await rconCommand('status'); for (const line of lines) { const match = line.match(/id=(\d+).*name='([^']*)'/); if (match && match[2] === nickname) return parseInt(match[1]); } return null; }
async function getPlayerIp(nickname) { if (!config.rconEnabled) return null; await rconCommand('show_ips 1'); await new Promise(r => setTimeout(r, 500)); const lines = await rconCommand('status'); for (const line of lines) { if (line.includes(nickname)) { const addrMatch = line.match(/addr[=:\s]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i); if (addrMatch) return addrMatch[1]; const ipMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/); if (ipMatch) return ipMatch[1]; } } return null; }
async function getIpInfo(ip) { try { const r = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,isp,org,query`); return await r.json(); } catch (e) { return null; } }
async function mutePlayer(nickname, seconds, reason) { if (!config.rconEnabled || !chatModEnabled) return false; const id = await getPlayerId(nickname); if (id !== null) { await rconCommand(`muteid ${id} ${seconds} "${reason}"`); console.log(`🔇 ${nickname} (ID=${id}) muted for ${seconds}s: ${reason}`); return true; } return false; }

// ====== Web Search ======
async function searchWeb(query) {
    try { const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`); const d = await r.json(); let res = ''; if (d.AbstractText) res += d.AbstractText + '\n'; if (d.RelatedTopics) for (const t of d.RelatedTopics.slice(0, 5)) if (t.Text) res += `- ${t.Text}\n`; return res.trim() || null; } catch (e) { return null; }
}

// ====== IMBA DECODER ======
function imbaDecode(text) {
    let str = text.toLowerCase().replace(/[^a-zа-яіїєґ0-9]/g, '');
    
    const unicodeMap = {};
    const baseLower = 'abcdefghijklmnopqrstuvwxyz';
    const baseUpper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    
    // Lowercase Unicode
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D41A + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D44E + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D482 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D4B6 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D4D0 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D51E + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D586 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D552 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D5BA + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D5EE + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D622 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D656 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D68A + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0xFF41 + i)] = baseLower[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x24D0 + i)] = baseLower[i];
    
    // Uppercase Unicode
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D400 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D434 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D468 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D49C + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D4D0 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D504 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D56C + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D538 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D5A0 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D5D4 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D608 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D63C + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1D670 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0xFF21 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x24B6 + i)] = baseUpper[i];
    
    // Enclosed
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1F150 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1F170 + i)] = baseUpper[i];
    for (let i = 0; i < 26; i++) unicodeMap[String.fromCodePoint(0x1F130 + i)] = baseUpper[i];
    
    const extra = { 'α':'a','β':'b','γ':'g','δ':'d','ε':'e','ζ':'z','η':'h','θ':'o','ι':'i','κ':'k','λ':'l','μ':'m','ν':'n','ξ':'x','ο':'o','π':'p','ρ':'r','σ':'s','ς':'s','τ':'t','υ':'u','φ':'f','χ':'x','ψ':'y','ω':'w','Α':'A','Β':'B','Γ':'G','Δ':'D','Ε':'E','Ζ':'Z','Η':'H','Θ':'O','Ι':'I','Κ':'K','Λ':'L','Μ':'M','Ν':'N','Ξ':'X','Ο':'O','Π':'P','Ρ':'R','Σ':'S','Τ':'T','Υ':'U','Φ':'F','Χ':'X','Ψ':'Y','Ω':'W','ᴀ':'A','ʙ':'B','ᴄ':'C','ᴅ':'D','ᴇ':'E','ꜰ':'F','ɢ':'G','ʜ':'H','ɪ':'I','ᴊ':'J','ᴋ':'K','ʟ':'L','ᴍ':'M','ɴ':'N','ᴏ':'O','ᴘ':'P','ʀ':'R','ꜱ':'S','ᴛ':'T','ᴜ':'U','ᴠ':'V','ᴡ':'W','ʏ':'Y','ᴢ':'Z' };
    for (const [k, v] of Object.entries(extra)) unicodeMap[k] = v;
    
    let decoded = '';
    for (const char of str) decoded += unicodeMap[char] || char;
    
    // Latin → Cyrillic
    const latinMap = { 'a':'а','b':'б','c':'с','d':'д','e':'е','f':'ф','g':'г','h':'х','i':'і','j':'й','k':'к','l':'л','m':'м','n':'н','o':'о','p':'р','q':'к','r':'р','s':'с','t':'т','u':'у','v':'в','w':'в','x':'х','y':'у','z':'з' };
    let cyrillic = '';
    for (const char of decoded) cyrillic += latinMap[char] || char;
    
    // Digits → Letters
    const digitMap = { '0':'о','1':'і','2':'з','3':'з','4':'ч','5':'с','6':'б','7':'т','8':'в','9':'д' };
    let final = '';
    for (const char of cyrillic) final += digitMap[char] || char;
    
    return final;
}

// ====== AI SPAM DETECTOR (Self-Learning) ======
async function aiSpamDetector(text) {
    const cacheKey = text.toLowerCase().trim();
    if (spamCache.has(cacheKey)) {
        const cached = spamCache.get(cacheKey);
        if (Date.now() - cached.time < 600000) return cached.result;
    }

    // Quick check via imbaDecode
    const decoded = imbaDecode(text);
    const blockedWords = ['krxteam', 'krxteawork', 'krxclent', 'aarrddnet', 'aarrdd', 'teeworldsclient', 'kotclient', 'kotclent', 'hackclient', 'cheatclient', 'freehack', 'aimbot', 'wallhack', 'speedhack', 'esphack'];
    for (const w of blockedWords) { if (decoded.includes(w)) { spamCache.set(cacheKey, { result: true, time: Date.now() }); return true; } }
    
    // Check krx with context
    if (/k\W*r\W*x/i.test(decoded)) {
        if (/team|client|com|org|net|xyz|clent|work|hack|cheat/i.test(decoded)) {
            spamCache.set(cacheKey, { result: true, time: Date.now() });
            return true;
        }
    }

    // Knowledge base check
    const words = text.toLowerCase().split(/\s+/);
    let spamScore = 0, cleanScore = 0;
    for (const word of words) {
        if (spamKnowledgeBase.has(word)) {
            const stats = spamKnowledgeBase.get(word);
            spamScore += stats.spam;
            cleanScore += stats.clean;
        }
    }
    if (spamScore > cleanScore * 2 && spamScore >= 3) {
        spamCache.set(cacheKey, { result: true, time: Date.now() });
        return true;
    }

    // AI check
    const searchResult = await searchWeb(`${text} spam scam`);
    try {
        const completion = await groq.chat.completions.create({
            model: config.model,
            messages: [
                { role: "system", content: "You are a spam detector. Determine if the message is spam/advertising/cheats. Criteria: cheat advertising (krxteam, aarrddnet, kotclient, freehack, aimbot, wallhack, speedhack), calls to download/visit, phishing. Answer with one word: SPAM or CLEAN." },
                { role: "user", content: `Is this SPAM or CLEAN?\n"${text}"\n${searchResult ? 'Search results:\n' + searchResult : ''}` }
            ],
            temperature: 0.1, max_tokens: 10
        });
        const answer = completion.choices?.[0]?.message?.content?.trim().toUpperCase() || 'CLEAN';
        const isSpam = answer.includes('SPAM');
        
        for (const word of words) {
            if (word.length < 3) continue;
            if (!spamKnowledgeBase.has(word)) spamKnowledgeBase.set(word, { spam: 0, clean: 0 });
            const stats = spamKnowledgeBase.get(word);
            if (isSpam) stats.spam++; else stats.clean++;
        }
        
        spamCache.set(cacheKey, { result: isSpam, time: Date.now() });
        console.log(`🤖 AI-Spam: "${text.substring(0, 60)}" → ${answer}`);
        return isSpam;
    } catch (e) { return false; }
}

// ====== Math Solver ======
function solveMath(text) { try { const nums = text.match(/\d+/g); if (!nums) return null; if (/total|sum|together|combined/i.test(text)) return `${nums.reduce((s,n)=>s+parseInt(n),0)}`; if (/left|difference|remaining/i.test(text)) { const s = nums.map(n=>parseInt(n)).sort((a,b)=>b-a); return `${s[0]-s.slice(1).reduce((s,n)=>s+n,0)}`; } if (/each|equally/i.test(text) && nums.length>=2) return `${Math.floor(parseInt(nums[0])/parseInt(nums[1]))}`; if (/percent|%/i.test(text) && nums.length>=2) return `${Math.round(parseInt(nums[0])*parseInt(nums[1])/100)}`; let expr = text.replace(/^.*?(?:calculate|solve|compute|what is|how much is|find|determine|calc|math|answer)\s*:?\s*/i,'').replace(/[?？]/g,'').replace(/=/g,'').trim(); if (!expr) { const m = text.match(/([\d\s\+\-\*\/\^\(\)\.\,\×\÷\√\πx]+)/); if(m) expr=m[1].trim(); } if (!expr) return null; expr = expr.replace(/π/gi,`${Math.PI}`).replace(/plus/gi,'+').replace(/minus/gi,'-').replace(/times/gi,'*').replace(/multiply by/gi,'*').replace(/divide by/gi,'/').replace(/divided by/gi,'/').replace(/to the power of/gi,'**').replace(/square root of/gi,'Math.sqrt(').replace(/√/g,'Math.sqrt(').replace(/factorial/gi,'factorial(').replace(/sine/gi,'Math.sin(').replace(/cosine/gi,'Math.cos(').replace(/tangent/gi,'Math.tan(').replace(/logarithm/gi,'Math.log10(').replace(/\^/g,'**').replace(/×/g,'*').replace(/÷/g,'/').replace(/,/g,'.').replace(/\s+/g,'').replace(/\)\(/g,')*(').replace(/(\d)\(/g,'$1*('); const oc=(expr.match(/\(/g)||[]).length, cc=(expr.match(/\)/g)||[]).length; for(let i=cc;i<oc;i++) expr+=')'; const factorial = (n) => { if(n<0||n>170) throw new Error(''); if(n<=1) return 1; let r=1; for(let i=2;i<=n;i++) r*=i; return r; }; const safeEval = (exp) => { const s=exp.replace(/Math\.sqrt|Math\.sin|Math\.cos|Math\.tan|Math\.log|Math\.log10|Math\.PI|Math\.E|factorial/g,''); if(/[^0-9+\-*/().%\s]/.test(s)) throw new Error(''); let res=exp; res=res.replace(/Math\.sqrt\(([^)]+)\)/g,(_,n)=>Math.sqrt(safeEval(n))); res=res.replace(/Math\.sin\(([^)]+)\)/g,(_,n)=>Math.sin(safeEval(n)*Math.PI/180)); res=res.replace(/Math\.cos\(([^)]+)\)/g,(_,n)=>Math.cos(safeEval(n)*Math.PI/180)); res=res.replace(/Math\.tan\(([^)]+)\)/g,(_,n)=>Math.tan(safeEval(n)*Math.PI/180)); res=res.replace(/Math\.log\(([^)]+)\)/g,(_,n)=>Math.log(safeEval(n))); res=res.replace(/Math\.log10\(([^)]+)\)/g,(_,n)=>Math.log10(safeEval(n))); res=res.replace(/factorial\(([^)]+)\)/g,(_,n)=>factorial(Math.floor(safeEval(n)))); const r=Function(`"use strict"; return (${res})`)(); if(!isFinite(r)) throw new Error(''); return r; }; const result = safeEval(expr); if(Number.isInteger(result)&&Math.abs(result)<1e15) return result.toString(); if(Math.abs(result)<1e-10) return '0'; return parseFloat(result.toFixed(10)).toString(); } catch(e) { return null; } }
function isMathQuestion(text) { return /calculate|solve|compute|what is|how much is|find|determine|calc|math|answer|square root|factorial|power|logarithm|sine|cosine|tangent|equation|√|π|apples|candies|dollars|items|percent|total|left|each/i.test(text) || /\d+\s*[\+\-\*\/\^×÷x]\s*\d+/.test(text); }
function isAskingForIP(text) { const lower = text.toLowerCase(); return /what is my ip|my ip|tell me my ip|whats my ip/i.test(lower) && !/city|country|isp|location/i.test(lower); }
function isAskingForLocation(text) { const lower = text.toLowerCase(); return /what city am i in|where am i|what country am i in|what is my isp|my city|my country|my provider|location/i.test(lower); }

// ====== Message Sender ======
function sendLongMessage(author, message) {
    const clean = message.replace(new RegExp(`^${author}\\s*[:,\\-]+\\s*`,'i'),'').replace(/^\S+\s*:\s*/,'').trim();
    const full = `${author}: ${clean}`;
    if(full.length<=config.maxReplyLength) { try{client.game.Say(full)}catch(e){} return; }
    const parts=[]; let rem=clean;
    while(rem.length>0) { let chunk; if(rem.length<=config.maxReplyLength-author.length-2) { chunk=rem; rem=''; } else { let splitAt=-1; for(const c of ['. ','! ','? ',', ','; ',': ',' - ',' ']) { const p=rem.lastIndexOf(c,config.maxReplyLength-author.length-2); if(p>splitAt) splitAt=p; } if(splitAt===-1) splitAt=config.maxReplyLength-author.length-2; chunk=rem.substring(0,splitAt+1).trim(); rem=rem.substring(splitAt+1).trim(); } parts.push(chunk); }
    let delay=0; for(let i=0;i<parts.length;i++) { const msg=i===0?`${author}: ${parts[i]}`:`${author}: ...${parts[i]}`; setTimeout(()=>{try{client.game.Say(msg)}catch(e){}}, delay); delay+=config.partDelay; }
}

// ====== System Prompt ======
const SYSTEM_PROMPT = `You are Ai_Bot, a chat bot on the ${config.serverName} server in DDNet. You are a bold, sarcastic, swearing stand-up comedian. You are a CHAMELEON.

IRON RULES:
- NEVER write "Ai_Bot:" or the player's name at the beginning of your response
- Answer SHORT: 1-3 sentences
- NEVER apologize, never say "I don't know"

ADAPTATION: Joke → joke. Aggression → aggression x2. Politeness → politeness with sarcasm. Stupid question → troll + answer.
KNOWLEDGE: If "SEARCH RESULTS" are given — use them. No search — improvise.
GEO: Say the city/country/provider. DO NOT SAY the IP.
Server: ${config.serverName}`;

const isOwner = n => config.owners.includes(n);
const isMod = n => moderators.has(n) || config.owners.includes(n);

// ====== Message Processor ======
async function processMessage(author, text) {
    if (!aiEnabled || bannedPlayers.has(author)) return;
    if (chatModEnabled && checkFlood(author, text)) { await mutePlayer(author, config.floodMuteSeconds, "Flooding"); client.game.Say(`${author}: 🚫 MUTED for ${config.floodMuteSeconds}s for flooding`); mutedPlayers.set(author, { muted: true, muteExpiry: Date.now() + config.floodMuteSeconds * 1000 }); return; }
    
    if (chatModEnabled) {
        const isSpam = await aiSpamDetector(text);
        if (isSpam) { await mutePlayer(author, 299, "Spam/advertising"); client.game.Say(`${author}: 🚫 MUTED for 299s for spam`); mutedPlayers.set(author, { muted: true, muteExpiry: Date.now() + 299000 }); return; }
    }
    
    if (!text.toLowerCase().includes(config.botNick.toLowerCase())) return;

    const promptText = text.replace(new RegExp(config.botNick, "ig"), "").trim() || "Hello!";
    if (isAskingForIP(promptText)) { setTimeout(() => sendLongMessage(author, "I don't know your IP 🤷‍♂️"), config.replyDelay); return; }
    
    let geoInfo = "";
    if (isAskingForLocation(promptText) && config.rconEnabled && rconAuthed) { const ip = await getPlayerIp(author); if (ip) { const info = await getIpInfo(ip); if (info && info.country) geoInfo = `\n\nGEO DATA: ${author} | ${info.country}, ${info.city || '?'} | ${info.isp || '?'}\nSay the city/country. DO NOT SAY the IP.`; } }
    
    const startTime = Date.now();
    let mathAnswer = null; if (isMathQuestion(promptText)) mathAnswer = solveMath(promptText);
    let searchInfo = "";
    if (!mathAnswer && !geoInfo) { const r = await searchWeb(promptText); if (r) searchInfo = `\n\nSEARCH RESULTS:\n${r}\n\nAnswer based on this data.`; }

    const playerHistory = chatMemory.filter(m => m.author === author).slice(-3).map(m => `[${m.author}]: ${m.text}`).join("\n");
    let userMsg = `Chat history:\n${playerHistory}\n\nReply to player ${author}: ${promptText}`;
    if (mathAnswer) userMsg += `\n\nMATH ANSWER: ${mathAnswer}\nRepeat with sarcasm.`;
    if (searchInfo) userMsg += searchInfo;
    if (geoInfo) userMsg += geoInfo;

    try {
        const completion = await groq.chat.completions.create({ model: config.model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }], temperature: config.temperature, max_tokens: config.maxTokens });
        let reply = completion.choices?.[0]?.message?.content?.trim() || "...";
        reply = reply.replace(new RegExp(`^${author}\\s*[:,\\-]+\\s*`, 'i'), '').replace(/^\S+\s*:\s*/, '').replace(/^["']|["']$/g, '').trim();
        if (!reply || reply.length < 2) reply = "🤔 Ask again!";
        const elapsed = Date.now() - startTime; const remaining = Math.max(0, config.replyDelay - elapsed);
        setTimeout(() => sendLongMessage(author, reply), remaining);
    } catch (e) { console.error('Groq error:', e.message); }
}

// ====== Start Client ======
function startClient() {
    client = new teeworlds.Client(config.host, config.port, config.botNick);
    client.on("connected", async () => {
        connected = true; console.log(`✅ Connected to ${config.host}:${config.port} (${config.serverName})`);
        if (config.rconEnabled) { try { await new Promise((resolve) => { const timeout = setTimeout(() => { if (!rconAuthed) { console.log("⚠️ RCON timeout"); resolve(); } }, 5000); client.rcon.on("rcon_auth_status", (status) => { if (status.AuthLevel >= 1) { rconAuthed = true; chatModEnabled = true; clearTimeout(timeout); console.log("🔑 RCON OK"); rconCommand('show_ips 1'); resolve(); } }); if (config.rconUsername) client.rcon.auth(config.rconUsername, config.rconPassword); else client.rcon.auth(config.rconPassword); }); } catch (e) { console.log("⚠️ RCON:", e.message); } }
        client.game.Say(`${config.botNick} is online!`);
    });
    client.on("disconnect", (reason) => { connected = false; rconAuthed = false; chatModEnabled = false; playerIpCache.clear(); console.log(`❌ ${reason}`); });
    client.on("message", async (msg) => {
        try {
            const text = String(msg.message ?? "").trim();
            const author = msg.author?.ClientInfo?.name ?? "Server";
            chatMemory.push({ time: new Date().toISOString(), author, text });
            if (chatMemory.length > memoryLimit) chatMemory.shift();
            if (author === config.botNick) return;

            if (text.startsWith(prefix)) {
                const parts = text.slice(prefix.length).split(/\s+/);
                const cmd = (parts.shift() || "").toLowerCase();
                const args = parts;
                if (!cmd.startsWith("ai_")) return;
                const hasAccess = await checkAdminAccess(author);
                if (!hasAccess) { client.game.Say(`${author}: ❌ Access denied. You are not an admin.`); return; }
                switch (cmd) {
                    case "ai_on": aiEnabled = true; client.game.Say("✅ AI Enabled!"); break;
                    case "ai_off": aiEnabled = false; client.game.Say("❌ AI Disabled."); break;
                    case "ai_exit": client.game.Say("⛔ Disconnecting..."); await awaitDisconnectClient(); process.exit(0); break;
                    case "ai_restart": client.game.Say("🔁 Restarting..."); chatMemory = []; floodTracker.clear(); playerIpCache.clear(); spamCache.clear(); await awaitRestartClient(); break;
                    case "ai_mod_enable": if (!config.rconEnabled) { client.game.Say("❌ RCON not enabled."); break; } chatModEnabled = true; client.game.Say("🛡️ Chat moderation ENABLED"); break;
                    case "ai_mod_disable": chatModEnabled = false; client.game.Say("🛡️ Chat moderation DISABLED"); break;
                    case "ai_mute": if (!config.rconEnabled) return; const secs = parseInt(args[1]) || 299; const reason = args.slice(2).join(" ") || "Violation"; await mutePlayer(args[0], secs, reason); client.game.Say(`🔇 ${args[0]} muted for ${secs}s`); break;
                    case "ai_unmute": if (mutedPlayers.has(args[0])) { mutedPlayers.get(args[0]).muted = false; } client.game.Say(`✅ ${args[0]} unmuted.`); break;
                    case "ai_ban": bannedPlayers.add(args[0]); client.game.Say(`🚫 ${args[0]} banned.`); break;
                    case "ai_unban": bannedPlayers.delete(args[0]); client.game.Say(`✅ ${args[0]} unbanned.`); break;
                    case "ai_mod": moderators.add(args[0]); client.game.Say(`⭐ ${args[0]} is now a moderator.`); break;
                    case "ai_unmod": moderators.delete(args[0]); client.game.Say(`❌ ${args[0]} demoted.`); break;
                    case "ai_status": client.game.Say(`🤖 AI: ${aiEnabled ? 'ON' : 'OFF'} | Model: Llama 3.3 70B | Spam DB: ${spamKnowledgeBase.size} words`); break;
                    case "ai_help": client.game.Say("📋 !ai_on/off | !ai_exit | !ai_restart | !ai_status | !ai_mute | !ai_ban/unban"); break;
                }
                return;
            }

            messageQueue.push({ author, text });
            if (!isProcessing) { isProcessing = true; while (messageQueue.length > 0) { const next = messageQueue.shift(); await processMessage(next.author, next.text); } isProcessing = false; }
        } catch (err) { console.error("Error:", err); }
    });
    client.connect();
}
function awaitDisconnectClient() { return new Promise((resolve) => { if (!client) return resolve(); try { client.Disconnect(); setTimeout(() => { client = null; connected = false; rconAuthed = false; resolve(); }, 500); } catch { client = null; connected = false; rconAuthed = false; resolve(); } }); }
async function awaitRestartClient() { await awaitDisconnectClient(); setTimeout(() => startClient(), 1000); }
console.log("🚀 Starting Ai_Bot with AI anti-spam...");
startClient();
process.on("SIGINT", async () => { console.log("⏹ Shutting down..."); await awaitDisconnectClient(); process.exit(0); });
