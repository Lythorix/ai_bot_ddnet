const teeworlds = require("teeworlds");
const Groq = require("groq-sdk");

// конфиг
const config = {
    host: "Server_port",
    port: 8303,
    botNick: "Ai_bot",
    groqKey: "Your_Key",
    model: "llama-3.1-8b-instant",
    maxReplyLength: 200,
    replyDelay: 3000,
    partDelay: 2000,
    rconPassword: "",
    rconUsername: "",
    rconEnabled: false,
    owners: ["Your_IGN"],
    defaultPrefix: "!",
    defaultMemorySize: 1150,
    maxMemoryLimit: 1500,
    temperature: 0.9,
    maxTokens: 4096
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
let playerMemory = {};
let bannedPlayers = new Set();
let moderators = new Set();
let isProcessing = false;
let messageQueue = [];
const mutedPlayers = new Map();

// ркон
async function rconCommand(cmd) {
    if (!config.rconEnabled || !client || !rconAuthed) return [];
    return new Promise((resolve) => {
        const lines = [];
        const handler = (line) => lines.push(line);
        client.rcon.on('rcon_line', handler);
        try { client.rcon.rcon(cmd); } catch (e) {}
        setTimeout(() => { client.rcon.removeListener('rcon_line', handler); resolve(lines); }, 1000);
    });
}

async function getPlayerId(nickname) {
    if (!config.rconEnabled) return null;
    const lines = await rconCommand('status');
    for (const line of lines) {
        const match = line.match(/id=(\d+).*name='([^']*)'/);
        if (match && match[2] === nickname) return parseInt(match[1]);
    }
    return null;
}

async function mutePlayer(nickname, seconds, reason) {
    if (!config.rconEnabled || !chatModEnabled) return false;
    const id = await getPlayerId(nickname);
    if (id !== null) {
        await rconCommand(`muteid ${id} ${seconds} "${reason}"`);
        console.log(`🔇 ${nickname} (ID=${id}) замучен на ${seconds}с: ${reason}`);
        return true;
    }
    return false;
}

// анти-спам
function normalizeText(text) {
    let result = text.toLowerCase();
    result = result.replace(/[^a-zа-яіїєґ0-9]/gi, '');
    const charMap = {};
    let decoded = '';
    for (const char of result) decoded += charMap[char] || char;
    return decoded;
}

function containsFamilyInsult(text) {
    if (!chatModEnabled) return false;
    const decoded = normalizeText(text);
    const familyInsults = [];
    for (const insult of familyInsults) {
        if (decoded.includes(insult)) return true;
    }
    return false;
}

// поиск
async function searchWeb(query) {
    try {
        const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
        const d = await r.json();
        let res = '';
        if (d.AbstractText) res += d.AbstractText + '\n';
        if (d.RelatedTopics) for (const t of d.RelatedTopics.slice(0, 5)) if (t.Text) res += `- ${t.Text}\n`;
        return res.trim() || null;
    } catch (e) { return null; }
}

// математика
function solveMath(text) {
    try {
        const nums = text.match(/\d+/g);
        if (!nums) return null;
        if (/всего|сумм|вместе|общее/i.test(text)) return `${nums.reduce((s,n)=>s+parseInt(n),0)}`;
        if (/осталось|разниц/i.test(text)) { const s = nums.map(n=>parseInt(n)).sort((a,b)=>b-a); return `${s[0]-s.slice(1).reduce((s,n)=>s+n,0)}`; }
        if (/каждый|поровну/i.test(text) && nums.length>=2) return `${Math.floor(parseInt(nums[0])/parseInt(nums[1]))}`;
        if (/процент|%/i.test(text) && nums.length>=2) return `${Math.round(parseInt(nums[0])*parseInt(nums[1])/100)}`;
        
        let expr = text.replace(/^.*?(?:посчитай|реши|вычисли|сколько будет|чему равно|посчитать|решить|вычислить|calc|math|solve|ответь|найди|определи)\s*:?\s*/i,'').replace(/[?？]/g,'').replace(/=/g,'').trim();
        if (!expr) { const m = text.match(/([\d\s\+\-\*\/\^\(\)\.\,\×\÷\√\πx]+)/); if(m) expr=m[1].trim(); }
        if (!expr) return null;
        
        expr = expr.replace(/π/gi,`${Math.PI}`).replace(/pi/gi,`${Math.PI}`).replace(/плюс/gi,'+').replace(/минус/gi,'-').replace(/умножить\s*на/gi,'*').replace(/поделить\s*на/gi,'/').replace(/разделить\s*на/gi,'/').replace(/делить\s*на/gi,'/').replace(/в\s*степени/gi,'**').replace(/корень\s*из/gi,'Math.sqrt(').replace(/√/g,'Math.sqrt(').replace(/факториал/gi,'factorial(').replace(/синус/gi,'Math.sin(').replace(/косинус/gi,'Math.cos(').replace(/тангенс/gi,'Math.tan(').replace(/логарифм/gi,'Math.log10(').replace(/\^/g,'**').replace(/×/g,'*').replace(/÷/g,'/').replace(/,/g,'.').replace(/\s+/g,'').replace(/\)\(/g,')*(').replace(/(\d)\(/g,'$1*(');
        
        const oc=(expr.match(/\(/g)||[]).length, cc=(expr.match(/\)/g)||[]).length;
        for(let i=cc;i<oc;i++) expr+=')';
        
        const factorial = (n) => { if(n<0||n>170) throw new Error(''); if(n<=1) return 1; let r=1; for(let i=2;i<=n;i++) r*=i; return r; };
        const safeEval = (exp) => {
            const s=exp.replace(/Math\.sqrt|Math\.sin|Math\.cos|Math\.tan|Math\.log|Math\.log10|Math\.PI|Math\.E|factorial/g,'');
            if(/[^0-9+\-*/().%\s]/.test(s)) throw new Error('');
            let res=exp;
            res=res.replace(/Math\.sqrt\(([^)]+)\)/g,(_,n)=>Math.sqrt(safeEval(n)));
            res=res.replace(/Math\.sin\(([^)]+)\)/g,(_,n)=>Math.sin(safeEval(n)*Math.PI/180));
            res=res.replace(/Math\.cos\(([^)]+)\)/g,(_,n)=>Math.cos(safeEval(n)*Math.PI/180));
            res=res.replace(/Math\.tan\(([^)]+)\)/g,(_,n)=>Math.tan(safeEval(n)*Math.PI/180));
            res=res.replace(/Math\.log\(([^)]+)\)/g,(_,n)=>Math.log(safeEval(n)));
            res=res.replace(/Math\.log10\(([^)]+)\)/g,(_,n)=>Math.log10(safeEval(n)));
            res=res.replace(/factorial\(([^)]+)\)/g,(_,n)=>factorial(Math.floor(safeEval(n))));
            const r=Function(`"use strict"; return (${res})`)();
            if(!isFinite(r)) throw new Error('');
            return r;
        };
        const result = safeEval(expr);
        if(Number.isInteger(result)&&Math.abs(result)<1e15) return result.toString();
        if(Math.abs(result)<1e-10) return '0';
        return parseFloat(result.toFixed(10)).toString();
    } catch(e) { return null; }
}

function isMathQuestion(text) {
    return /посчитай|реши|вычисли|сколько будет|чему равно|посчитать|решить|вычислить|calc|math|solve|ответь|найди|определи|корень|факториал|степен|логарифм|синус|косинус|тангенс|уравнение|√|π|яблок|конфет|рубл|штук|процент|всего|осталось|поровну/i.test(text) || /\d+\s*[\+\-\*\/\^×÷x]\s*\d+/.test(text);
}

// отправка
function sendLongMessage(author, message) {
    const clean = message.replace(new RegExp(`^${author}\\s*[:,\\-]+\\s*`,'i'),'').replace(/^\S+\s*:\s*/,'').trim();
    const full = `${author}: ${clean}`;
    if(full.length<=config.maxReplyLength) { setTimeout(()=>{try{client.game.Say(full)}catch(e){}},config.replyDelay); return; }
    const parts=[];
    let rem=clean;
    while(rem.length>0) {
        let chunk;
        if(rem.length<=config.maxReplyLength-author.length-2) { chunk=rem; rem=''; }
        else {
            let splitAt=-1;
            for(const c of ['. ','! ','? ',', ','; ',': ',' - ',' ']) { const p=rem.lastIndexOf(c,config.maxReplyLength-author.length-2); if(p>splitAt) splitAt=p; }
            if(splitAt===-1) splitAt=config.maxReplyLength-author.length-2;
            chunk=rem.substring(0,splitAt+1).trim(); rem=rem.substring(splitAt+1).trim();
        }
        parts.push(chunk);
    }
    let delay=config.replyDelay;
    for(let i=0;i<parts.length;i++) { const msg=i===0?`${author}: ${parts[i]}`:`${author}: ...${parts[i]}`; setTimeout(()=>{try{client.game.Say(msg)}catch(e){}},delay); delay+=config.partDelay; }
}

// промпт
const SYSTEM_PROMPT = `Ты — Ai_Bot, чат-бот в игре DDNet.

🚨 ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. НИКОГДА не пиши "Ai_Bot:" или имя игрока в начале ответа
2. Отвечай ТОЛЬКО на последнее сообщение
3. НИКОГДА не извиняйся
4. НИКОГДА не говори "я не знаю"

🎭 ЛИЧНОСТЬ: Дерзкий, саркастичный, матершинный стендапер.
🎯 СТИЛЬ: КОРОТКО (1-3 предложения). Сначала реакция, потом ответ.
🧮 МАТЕМАТИКА: Решаешь ВСЕ задачи. "ОТВЕТ: X" → "X. [сарказм]"
🔍 ПОИСК: Не DDNet/не математика → используй ПОИСК. Нет поиска → ИМПРОВИЗИРУЙ.`;

const isOwner = n => config.owners.includes(n);
const isMod = n => moderators.has(n) || isOwner(n);

// обработчик
async function processMessage(author, text) {
    if (!aiEnabled || bannedPlayers.has(author)) return;
    if (!text.toLowerCase().includes(config.botNick.toLowerCase())) return;

    // чат
    if (chatModEnabled && containsFamilyInsult(text)) {
        await mutePlayer(author, 299, "Оск род");
        client.game.Say(`${author}: 🚫 ЗАМУЧЕН на 299 секунд за оскорбление родни`);
        mutedPlayers.set(author, { muted: true, muteExpiry: Date.now() + 299000 });
        return;
    }

    const promptText = text.replace(new RegExp(config.botNick,"ig"),"").trim()||"Привет!";
    let mathAnswer = null;
    if(isMathQuestion(promptText)) mathAnswer=solveMath(promptText);

    let jokeInfo="";
    if(/^скажи\s+|^произнеси\s+|^повтори\s+|^ответь\s+|^напиши\s+|^озвучь\s+|^крикни\s+|^проговори\s+|^вымолви\s+|^изреки\s+|^молви\s+|^брякни\s+|^ляпни\s+|^сморозь\s+|^зачитай\s+/i.test(promptText)&&!mathAnswer) {
        const r=await searchWeb(`${promptText} смешной ответ`);
        if(r) jokeInfo=`\n\nШУТКИ:\n${r}\n\nПридумай похожий ответ.`;
    }

    let searchInfo="";
    if(!/ddnet|teeworlds|сервер|карта|rcon|нинздя|джетпак|linear/i.test(promptText)&&!mathAnswer&&!jokeInfo) {
        const r=await searchWeb(promptText);
        if(r) searchInfo=`\n\nПОИСК:\n${r}\n\nОтветь на основе этих данных.`;
    }

    const recent=chatMemory.slice(-5).map(m=>`[${m.author}]: ${m.text}`).join("\n");
    let userMsg=`Контекст:\n${recent}\n\nОтветь ТОЛЬКО на это от ${author}: ${promptText}`;
    if(mathAnswer) userMsg+=`\n\nОТВЕТ: ${mathAnswer}\nПовтори с сарказмом.`;
    if(jokeInfo) userMsg+=jokeInfo;
    if(searchInfo) userMsg+=searchInfo;

    const completion=await groq.chat.completions.create({
        model:config.model,
        messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:userMsg}],
        temperature:config.temperature,
        max_tokens:config.maxTokens
    });

    let reply=completion.choices?.[0]?.message?.content?.trim()||"...";
    reply=reply.replace(new RegExp(`^${author}\\s*[:,\\-]+\\s*`,'i'),'').replace(/^\S+\s*:\s*/,'').trim();
    if(!reply||reply.length<2) reply="🤔 Спроси ещё!";
    sendLongMessage(author,reply);
}

// старт
function startClient() {
    client=new teeworlds.Client(config.host,config.port,config.botNick);

    client.on("connected",async()=>{
        connected=true;
        console.log(`✅ Подключен к ${config.host}:${config.port}`);
        console.log(`🔧 RCON: ${config.rconEnabled ? 'ВКЛЮЧЁН (чат-модерация активна)' : 'ВЫКЛЮЧЕН (только ИИ)'}`);
        console.log(`🛡️ Чат-модерация: ${chatModEnabled ? 'АКТИВНА' : 'ОТКЛЮЧЕНА'}`);
        
        // ркон
        if (config.rconEnabled) {
            try{
                await new Promise((resolve)=>{
                    const timeout=setTimeout(()=>{if(!rconAuthed){console.log("⚠️ RCON таймаут");resolve();}},5000);
                    client.rcon.on("rcon_auth_status",(status)=>{
                        if(status.AuthLevel>=1){
                            rconAuthed=true;
                            chatModEnabled=true;
                            clearTimeout(timeout);
                            console.log("🔑 RCON OK — чат-модерация активна");
                            resolve();
                        }
                    });
                    if(config.rconUsername) client.rcon.auth(config.rconUsername,config.rconPassword);
                    else client.rcon.auth(config.rconPassword);
                });
            }catch(e){console.log("⚠️ RCON:",e.message);}
        }
        
        client.game.Say(`${config.botNick} онлайн!`);
    });

    client.on("disconnect",(reason)=>{
        connected=false;
        rconAuthed=false;
        chatModEnabled=false;
        console.log(`❌ ${reason}`);
    });

    client.on("message",async(msg)=>{
        try{
            const text=String(msg.message??"").trim();
            const author=msg.author?.ClientInfo?.name??"Server";
            chatMemory.push({time:new Date().toISOString(),author,text});
            if(chatMemory.length>memoryLimit) chatMemory.shift();
            if(author===config.botNick) return;

            if(text.startsWith(prefix)){
                const parts=text.slice(prefix.length).split(/\s+/);
                const cmd=(parts.shift()||"").toLowerCase();
                const args=parts;
                if(!cmd.startsWith("ai_")) return;
                const owner=isOwner(author),mod=isMod(author);
                if(!mod&&!owner) return;
                switch(cmd){
                    case "ai_on":aiEnabled=true;client.game.Say("✅ Включен!");break;
                    case "ai_off":aiEnabled=false;client.game.Say("❌ Выключен.");break;
                    case "ai_mod_enable":
                        if(!config.rconEnabled) { client.game.Say("❌ RCON не включён. Установи rconEnabled: true в конфиге."); break; }
                        chatModEnabled=true;
                        client.game.Say("🛡️ Чат-модерация ВКЛЮЧЕНА");
                        break;
                    case "ai_mod_disable":
                        chatModEnabled=false;
                        client.game.Say("🛡️ Чат-модерация ОТКЛЮЧЕНА");
                        break;
                    case "ai_mute":if(!mod||!config.rconEnabled)return;const secs=parseInt(args[1])||299;const reason=args.slice(2).join(" ")||"Нарушение";await mutePlayer(args[0],secs,reason);client.game.Say(`🔇 ${args[0]} замучен на ${secs}с`);break;
                    case "ai_unmute":if(!mod)return;if(mutedPlayers.has(args[0])){mutedPlayers.get(args[0]).muted=false;}client.game.Say(`✅ ${args[0]} размучен.`);break;
                    case "ai_ban":if(!mod)return;bannedPlayers.add(args[0]);client.game.Say(`🚫 ${args[0]} забанен.`);break;
                    case "ai_unban":if(!mod)return;bannedPlayers.delete(args[0]);client.game.Say(`✅ ${args[0]} разбанен.`);break;
                    case "ai_mod":if(!owner)return;moderators.add(args[0]);client.game.Say(`⭐ ${args[0]} модератор.`);break;
                    case "ai_unmod":if(!owner)return;moderators.delete(args[0]);client.game.Say(`❌ ${args[0]} разжалован.`);break;
                    case "ai_status":
                        client.game.Say(`🤖 AI:${aiEnabled?'ON':'OFF'} | RCON:${config.rconEnabled?'ON':'OFF'} | ChatMod:${chatModEnabled?'ON':'OFF'}`);
                        break;
                    case "ai_help":client.game.Say("📋 !ai_on/off|!ai_status|!ai_mute ник|!ai_mod_enable/disable|!ai_ban/unban");break;
                }
                return;
            }

            messageQueue.push({author,text});
            if(!isProcessing){isProcessing=true;while(messageQueue.length>0){const next=messageQueue.shift();await processMessage(next.author,next.text);}isProcessing=false;}
        }catch(err){console.error("Ошибка:",err);}
    });

    client.connect();
}

function awaitDisconnectClient(){return new Promise((resolve)=>{if(!client)return resolve();try{client.Disconnect();setTimeout(()=>{client=null;connected=false;rconAuthed=false;resolve();},500);}catch{client=null;connected=false;rconAuthed=false;resolve();}});}
async function awaitRestartClient(){await awaitDisconnectClient();setTimeout(()=>startClient(),1000);}

console.log("🚀 Запуск Ai_Bot...");
console.log(`🔧 RCON: ${config.rconEnabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН (бот работает без RCON)'}`);
startClient();
process.on("SIGINT",async()=>{console.log("⏹ Завершение...");await awaitDisconnectClient();process.exit(0);});
