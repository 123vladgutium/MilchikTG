/* MilchikTG — browser client. Only the Supabase publishable/anon key belongs here.
   Never put a Supabase service_role/secret key in a public website. */
const CONFIG = {
  SUPABASE_URL: "https://rsqcppzdnxghmpcqkcon.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_flV3kJ1AMYglA9Ag0BNdnw_9_0yqzz0"
};

const $ = (selector) => document.querySelector(selector);
const authView = $("#authView");
const appView = $("#appView");
const toastEl = $("#toast");
let client = null;
let currentUser = null;
let currentProfile = null;
let currentConversationId = null;
let currentPeer = null;
let messageChannel = null;
let listChannel = null;
let authMode = "login";
let conversations = [];
let peopleTimer = null;
let toastTimer = null;
let messageCache = [];
let recording = null;
let recordedChunks = [];
let publicProfileTarget = null;

function showToast(message, error = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", error);
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 4200);
}
function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "?";
}
function timeLabel(value) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  return date.toLocaleDateString([], {day:"2-digit", month:"2-digit"});
}
function setMode(mode) {
  authMode = mode;
  $("#authForm").classList.remove("hidden");
  $("#verifyForm").classList.add("hidden");
  document.querySelectorAll("[data-mode]").forEach(btn => btn.classList.toggle("active", btn.dataset.mode === mode));
  $("#nameLabel").classList.toggle("hidden", mode !== "register");
  $("#authSubmit").textContent = mode === "register" ? "Создать аккаунт" : "Войти";
  $("#resetPassword").classList.toggle("hidden", mode !== "login");
  $("#password").autocomplete = mode === "register" ? "new-password" : "current-password";
}
function configured() {
  return CONFIG.SUPABASE_URL.startsWith("https://") &&
    !CONFIG.SUPABASE_URL.includes("PASTE_") &&
    CONFIG.SUPABASE_PUBLISHABLE_KEY.length > 20 &&
    !CONFIG.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");
}
function showApp() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
}
function showAuth() {
  appView.classList.add("hidden");
  authView.classList.remove("hidden");
  currentUser = null;
  currentProfile = null;
  currentConversationId = null;
  currentPeer = null;
  stopSubscriptions();
}
async function loadMyProfile() {
  const {data, error} = await client.from("profiles").select("id, display_name, bio, avatar_url, created_at").eq("id", currentUser.id).single();
  if (error) throw error;
  currentProfile = data;
  $("#myName").textContent = data.display_name || currentUser.email.split("@")[0];
  $("#myEmail").textContent = currentUser.email;
  setAvatar($("#myAvatar"), data.avatar_url, data.display_name || currentUser.email);
}
async function refreshConversations() {
  if (!currentUser) return;
  const {data: membershipRows, error} = await client
    .from("conversation_members")
    .select("conversation_id, conversations(id, created_at, updated_at, type, title)")
    .eq("user_id", currentUser.id);
  if (error) { showToast("Не удалось загрузить чаты: " + error.message, true); return; }
  const ids = (membershipRows || []).map(row => row.conversation_id);
  if (!ids.length) {
    conversations = [];
    renderChatList();
    return;
  }
  const {data: memberRows, error: memberError} = await client
    .from("conversation_members")
    .select("conversation_id, user_id, profiles!conversation_members_user_id_fkey(id, display_name, bio, avatar_url)")
    .in("conversation_id", ids);
  if (memberError) { showToast("Ошибка загрузки участников: " + memberError.message, true); return; }
  const {data: messageRows, error: messageError} = await client
    .from("messages")
    .select("id, conversation_id, sender_id, content, attachment_url, attachment_type, edited_at, is_pinned, created_at")
    .in("conversation_id", ids)
    .order("created_at", {ascending:false});
  if (messageError) { showToast("Ошибка загрузки сообщений: " + messageError.message, true); return; }

  conversations = ids.map(id => {
    const membership = membershipRows.find(row => row.conversation_id === id);
    const members = (memberRows || []).filter(row => row.conversation_id === id);
    const peerRow = members.find(row => row.user_id !== currentUser.id);
    const peer = peerRow?.profiles || {id: peerRow?.user_id, display_name:"Пользователь"};
    const meta = membership?.conversations || {};
    const latest = (messageRows || []).find(row => row.conversation_id === id);
    return {id, type:meta.type || "direct", title:meta.title || "", created_at:meta.created_at, updated_at:latest?.created_at || meta.updated_at, peer, latest};
  }).sort((a,b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  renderChatList();
}
function renderChatList() {
  const list = $("#chatList");
  const query = $("#chatSearch").value.trim().toLowerCase();
  const items = conversations.filter(c => {
    const title = (c.title || c.peer.display_name || "").toLowerCase();
    const preview = (c.latest?.content || "").toLowerCase();
    return title.includes(query) || preview.includes(query);
  });
  if (!items.length) {
    list.innerHTML = `<div class="empty-list">${query ? "Ничего не найдено" : "Пока нет чатов.<br>Нажмите «Новый чат», чтобы найти человека."}</div>`;
    return;
  }
  list.innerHTML = items.map(c => {
    const name = c.title || c.peer.display_name || "Пользователь";
    const preview = c.latest ? (c.latest.sender_id === currentUser.id ? "Вы: " : "") + (c.latest.attachment_type === "audio" ? "🎙 Голосовое сообщение" : c.latest.attachment_url ? "📷 Фото" : c.latest.content) : (c.type === "channel" ? "Канал" : c.type === "group" ? "Группа" : "Начните общение");
    return `<button class="chat-item ${c.id === currentConversationId ? "active" : ""}" data-chat-id="${c.id}">
      <div class="avatar">${c.peer?.avatar_url && c.type === "direct" ? `<img src="${escapeHTML(c.peer.avatar_url)}" alt="">` : escapeHTML(initials(name))}</div>
      <div class="chat-copy"><div class="chat-topline"><strong>${escapeHTML(name)}</strong><span class="chat-time">${c.latest ? timeLabel(c.latest.created_at) : ""}</span></div>
      <div class="chat-preview">${escapeHTML(preview)}</div></div></button>`;
  }).join("");
  list.querySelectorAll("[data-chat-id]").forEach(button => button.addEventListener("click", () => openConversation(button.dataset.chatId)));
}
async function openConversation(id) {
  const item = conversations.find(c => c.id === id);
  if (!item) return;
  currentConversationId = id;
  currentPeer = item.peer;
  const chatName = item.title || item.peer.display_name || "Пользователь";
  $("#peerName").textContent = chatName;
  $("#peerEmail").textContent = item.type === "channel" ? "Канал" : item.type === "group" ? "Группа" : "Личная переписка";
  setAvatar($("#peerAvatar"), item.type === "direct" ? item.peer?.avatar_url : "", chatName);
  $("#peerAvatar").style.cursor = item.type === "direct" ? "pointer" : "default";
  $("#welcome").classList.add("hidden");
  $("#conversation").classList.remove("hidden");
  appView.classList.add("chat-open");
  renderChatList();
  await loadMessages();
  subscribeToMessages();
}
async function loadMessages() {
  if (!currentConversationId) return;
  const {data, error} = await client.from("messages")
    .select("id, conversation_id, sender_id, content, attachment_url, attachment_type, edited_at, is_pinned, created_at")
    .eq("conversation_id", currentConversationId)
    .order("created_at", {ascending:true})
    .limit(300);
  if (error) { showToast("Не удалось загрузить сообщения: " + error.message, true); return; }
  renderMessages(data || []);
}
function renderMessages(rows) {
  messageCache = rows || [];
  const container = $("#messages");
  if (!rows.length) {
    container.innerHTML = '<div class="system-note">Это начало переписки. Напишите первое сообщение.</div>';
    return;
  }
  container.innerHTML = rows.map(m => {
    const mine = m.sender_id === currentUser.id;
    const attachment = m.attachment_url ? (m.attachment_type === "audio" ? `<audio class="message-audio" controls preload="metadata" src="${escapeHTML(m.attachment_url)}"></audio>` : `<a href="${escapeHTML(m.attachment_url)}" target="_blank" rel="noopener"><img class="message-image" src="${escapeHTML(m.attachment_url)}" alt="Фото в сообщении" loading="lazy"></a>`) : "";
    const actions = mine ? `<div class="message-actions"><button data-msg-action="pin" data-msg-id="${m.id}">${m.is_pinned ? "📌 Открепить" : "📌 Закрепить"}</button>${m.content ? `<button data-msg-action="edit" data-msg-id="${m.id}">Изменить</button>` : ""}<button class="message-delete" data-msg-action="delete" data-msg-id="${m.id}">Удалить</button></div>` : "";
    return `<article class="message-row ${mine ? "mine" : ""} ${m.is_pinned ? "pinned-message" : ""}"><div class="bubble">${m.is_pinned ? '<div class="pinned-label">📌 Закреплено</div>' : ""}${attachment}${m.content ? `<div>${escapeHTML(m.content)}</div>` : ""}</div><div class="message-meta">${timeLabel(m.created_at)}${m.edited_at ? " · изменено" : ""}${mine ? " · Вы" : ""}</div>${actions}</article>`;
  }).join("");
  container.querySelectorAll("[data-msg-action]").forEach(button => button.addEventListener("click", () => handleMessageAction(button.dataset.msgAction, button.dataset.msgId)));
  container.scrollTop = container.scrollHeight;
}
async function handleMessageAction(action, id) {
  const message = messageCache.find(m => String(m.id) === String(id));
  if (!message || message.sender_id !== currentUser.id) return;
  if (action === "edit") {
    const updated = prompt("Изменить сообщение:", message.content || "");
    if (updated === null) return;
    const content = updated.trim();
    if (!content) { showToast("Пустое сообщение нельзя сохранить.", true); return; }
    const {error} = await client.from("messages").update({content, edited_at:new Date().toISOString()}).eq("id", id).eq("sender_id", currentUser.id);
    if (error) { showToast("Не удалось изменить сообщение: " + error.message, true); return; }
  } else if (action === "delete") {
    if (!confirm("Удалить это сообщение? Это действие нельзя отменить.")) return;
    const {error} = await client.from("messages").delete().eq("id", id).eq("sender_id", currentUser.id);
    if (error) { showToast("Не удалось удалить сообщение: " + error.message, true); return; }
  } else if (action === "pin") {
    const {error} = await client.from("messages").update({is_pinned:!message.is_pinned}).eq("id", id).eq("sender_id", currentUser.id);
    if (error) { showToast("Не удалось закрепить сообщение: " + error.message, true); return; }
  }
  await loadMessages(); await refreshConversations();
}
function setAvatar(element, url, name) {
  if (!element) return;
  if (url) element.innerHTML = `<img src="${escapeHTML(url)}" alt="Аватар">`;
  else element.textContent = initials(name || "?");
}
async function showPublicProfile(userId) {
  if (!userId) return;
  const {data,error} = await client.from("profiles").select("id, display_name, bio, avatar_url, created_at").eq("id",userId).maybeSingle();
  if (error || !data) { showToast("Не удалось загрузить профиль.", true); return; }
  publicProfileTarget = data;
  setAvatar($("#publicProfileAvatar"), data.avatar_url, data.display_name);
  $("#publicProfileName").textContent = data.display_name || "Пользователь";
  $("#publicProfileBio").textContent = data.bio || "Пользователь пока ничего не рассказал о себе.";
  $("#publicProfileMessageBtn").classList.toggle("hidden", data.id === currentUser.id);
  $("#publicProfileDialog").showModal();
}
async function uploadMedia(file, kind) {
  if (!file) return null;
  if (file.size > (kind === "avatar" ? 5 : 12) * 1024 * 1024) throw new Error(kind === "avatar" ? "Аватар должен быть меньше 5 МБ." : "Файл должен быть меньше 12 МБ.");
  const path = `${currentUser.id}/${kind}-${Date.now()}-${file.name ? file.name.replace(/[^a-zA-Z0-9._-]/g,"_") : "voice.webm"}`;
  const {error} = await client.storage.from("milchiktg-media").upload(path,file,{upsert:true,contentType:(file.type || "audio/webm").split(";")[0]});
  if (error) throw error;
  return client.storage.from("milchiktg-media").getPublicUrl(path).data.publicUrl;
}
async function sendAudioBlob(blob) {
  if (!currentConversationId || !blob) return;
  try {
    showToast("Отправляю голосовое сообщение…");
    const file = new File([blob], `voice-${Date.now()}.webm`, {type:blob.type || "audio/webm"});
    const url = await uploadMedia(file,"voice");
    const {error} = await client.from("messages").insert({conversation_id:currentConversationId,sender_id:currentUser.id,content:"",attachment_url:url,attachment_type:"audio"});
    if (error) throw error;
    await loadMessages(); await refreshConversations(); showToast("Голосовое сообщение отправлено.");
  } catch(error) { showToast("Не удалось отправить голосовое сообщение: " + error.message,true); }
}

async function sendMessage(event) {
  event.preventDefault();
  const content = $("#messageInput").value.trim();
  if (!content || !currentConversationId) return;
  const button = $("#sendBtn");
  button.disabled = true;
  const {error} = await client.from("messages").insert({
    conversation_id: currentConversationId,
    sender_id: currentUser.id,
    content
  });
  button.disabled = false;
  if (error) { showToast("Сообщение не отправлено: " + error.message, true); return; }
  $("#messageInput").value = "";
  $("#messageInput").style.height = "auto";
  await loadMessages();
  await refreshConversations();
}
function stopSubscriptions() {
  if (messageChannel && client) client.removeChannel(messageChannel);
  if (listChannel && client) client.removeChannel(listChannel);
  messageChannel = null;
  listChannel = null;
}
function subscribeToMessages() {
  if (messageChannel) client.removeChannel(messageChannel);
  if (!currentConversationId) return;
  messageChannel = client.channel("messages-" + currentConversationId)
    .on("postgres_changes", {event:"*", schema:"public", table:"messages", filter:"conversation_id=eq." + currentConversationId}, async payload => {
      await loadMessages(); if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser.id) playMessageSound();
      await refreshConversations();
    }).subscribe();
}
function subscribeToChatList() {
  if (listChannel) client.removeChannel(listChannel);
  listChannel = client.channel("milchiktg-list-" + currentUser.id)
    .on("postgres_changes", {event:"INSERT", schema:"public", table:"messages"}, () => refreshConversations())
    .on("postgres_changes", {event:"INSERT", schema:"public", table:"conversation_members", filter:"user_id=eq." + currentUser.id}, () => refreshConversations())
    .subscribe();
}
function openPeopleDialog() {
  $("#peopleSearch").value = "";
  $("#peopleResults").innerHTML = '<p class="muted">Введите минимум 2 символа для поиска.</p>';
  $("#peopleDialog").showModal();
  setTimeout(() => $("#peopleSearch").focus(), 80);
}
async function searchPeople() {
  const query = $("#peopleSearch").value.trim();
  const result = $("#peopleResults");
  if (query.length < 2) {
    result.innerHTML = '<p class="muted">Введите минимум 2 символа для поиска.</p>';
    return;
  }
  result.innerHTML = '<p class="muted">Поиск…</p>';
  const {data, error} = await client.from("profiles")
    .select("id, display_name, bio, avatar_url")
    .neq("id", currentUser.id)
    .ilike("display_name", "%" + query.replace(/[%_,]/g, " ") + "%")
    .order("display_name")
    .limit(20);
  if (error) { result.innerHTML = `<p class="muted">Ошибка поиска: ${escapeHTML(error.message)}</p>`; return; }
  if (!data?.length) {
    result.innerHTML = '<p class="muted">Никого не нашли. Поиск идёт по отображаемому имени.</p>';
    return;
  }
  result.innerHTML = data.map(person => `<button class="person-result" data-person-id="${person.id}">
    <div class="avatar">${person.avatar_url ? `<img src="${escapeHTML(person.avatar_url)}" alt="">` : escapeHTML(initials(person.display_name))}</div><div class="person-info"><strong>${escapeHTML(person.display_name || "Пользователь")}</strong><span>${escapeHTML((JSON.parse(localStorage.getItem("milchiktg-prefs")||"{}").bioSearch === false) ? "Пользователь MilchikTG" : (person.bio || "Пользователь MilchikTG"))}</span></div>
  </button>`).join("");
  result.querySelectorAll("[data-person-id]").forEach(button => button.addEventListener("click", () => startConversation(button.dataset.personId)));
}
async function startConversation(targetId) {
  const {data, error} = await client.rpc("create_direct_conversation", {target_user_id: targetId});
  if (error) { showToast("Не удалось создать чат: " + error.message, true); return; }
  $("#peopleDialog").close();
  await refreshConversations();
  await openConversation(data);
}
async function saveProfile(event) {
  event.preventDefault();
  const display_name = $("#profileName").value.trim();
  const bio = $("#profileBio").value.trim();
  if (!display_name) { showToast("Введите отображаемое имя.", true); return; }
  const {error} = await client.from("profiles").update({display_name, bio}).eq("id", currentUser.id);
  if (error) { showToast("Не удалось сохранить профиль: " + error.message, true); return; }
  await loadMyProfile();
  $("#profileDialog").close();
  await refreshConversations();
  showToast("Профиль сохранён.");
}
async function handleAuth(event) {
  event.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const button = $("#authSubmit");
  button.disabled = true;
  try {
    if (authMode === "register") {
      const displayName = $("#displayName").value.trim();
      if (!displayName) throw new Error("Введите имя.");
      const {data, error} = await client.auth.signUp({email, password, options:{data:{display_name:displayName}, emailRedirectTo: location.origin + location.pathname}});
      if (error) throw error;
      if (!data.session) {
        $("#authForm").classList.add("hidden");
        $("#verifyForm").classList.remove("hidden");
        showToast("Письмо отправлено. Открой ссылку в письме для подтверждения.");
        return;
      }
      await enterApp(data.user);
    } else {
      const {data, error} = await client.auth.signInWithPassword({email, password});
      if (error) throw error;
      await enterApp(data.user);
    }
  } catch (error) {
    showToast(error.message || "Ошибка авторизации.", true);
  } finally {
    button.disabled = false;
  }
}
async function enterApp(user) {
  currentUser = user;
  showApp();
  try {
    await loadMyProfile();
    await refreshConversations();
    subscribeToChatList();
  } catch (error) {
    showToast("Не удалось загрузить профиль. Выполните SQL-настройку из файла README.", true);
  }
}
function playMessageSound() {
  let prefs={}; try { prefs=JSON.parse(localStorage.getItem("milchiktg-prefs")||"{}"); } catch {}
  if (!prefs.sound) return;
  try { const ctx=new (window.AudioContext||window.webkitAudioContext)(); const osc=ctx.createOscillator(); const gain=ctx.createGain(); osc.frequency.value=740; gain.gain.value=0.035; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.09); osc.onended=()=>ctx.close(); } catch {}
}
function applyAppearance(prefs={}) {
  document.documentElement.style.setProperty("--accent", prefs.accent || "#7c5cff");
  document.body.classList.toggle("compact-chats", !!prefs.compact);
  document.body.classList.toggle("reduce-motion", !!prefs.motion);
}
function loadAppearanceSettings() {
  let prefs={}; try { prefs=JSON.parse(localStorage.getItem("milchiktg-prefs")||"{}"); } catch {}
  $("#accentSetting").value=prefs.accent||"#7c5cff"; $("#compactSetting").checked=!!prefs.compact;
  $("#motionSetting").checked=!!prefs.motion; $("#soundSetting").checked=!!prefs.sound; $("#bioSearchSetting").checked=prefs.bioSearch!==false;
  applyAppearance(prefs);
}
async function browseChannels() {
  $("#channelsResults").innerHTML='<p class="muted">Загрузка каналов…</p>'; $("#channelsDialog").showModal();
  const {data,error}=await client.from("conversations").select("id,title,created_by").eq("type","channel").order("created_at",{ascending:false}).limit(50);
  if(error){$("#channelsResults").innerHTML=`<p class="muted">Не удалось загрузить каналы. Выполни supabase-upgrade.sql в Supabase.</p>`;return;}
  if(!data?.length){$("#channelsResults").innerHTML='<p class="muted">Пока нет открытых каналов. Создай первый через кнопку ＋.</p>';return;}
  const {data:mine}=await client.from("conversation_members").select("conversation_id").eq("user_id",currentUser.id);
  const joined=new Set((mine||[]).map(x=>x.conversation_id));
  $("#channelsResults").innerHTML=data.map(ch=>`<div class="channel-result"><div><strong>${escapeHTML(ch.title||"Канал")}</strong><span>Открытый канал</span></div><button class="primary channel-join" data-channel-id="${ch.id}">${joined.has(ch.id)?"Открыть":"Вступить"}</button></div>`).join("");
  $("#channelsResults").querySelectorAll("[data-channel-id]").forEach(btn=>btn.addEventListener("click",async()=>{
    const id=btn.dataset.channelId;
    if(!joined.has(id)){const {error}=await client.rpc("join_public_channel",{target_channel_id:id});if(error){showToast(error.message,true);return;}}
    $("#channelsDialog").close();await refreshConversations();await openConversation(id);
  }));
}

async function init() {
  document.querySelectorAll("[data-mode]").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
  loadAppearanceSettings();
  if (!configured()) {
    showToast("Сначала вставьте URL и publishable key Supabase в начало script.js.", true);
    $("#authSubmit").disabled = true;
    $("#resetPassword").disabled = true;
    return;
  }
  if (!window.supabase?.createClient) {
    showToast("Не загрузилась библиотека Supabase. Проверьте интернет и обновите страницу.", true);
    return;
  }
  client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);
  $("#authForm").addEventListener("submit", handleAuth);
  $("#verifyForm").addEventListener("submit", event => event.preventDefault());
  $("#resendLink").addEventListener("click", async () => {
    const email = $("#email").value.trim();
    if (!email) { showToast("Введите email на вкладке регистрации.", true); return; }
    const button = $("#resendLink"); button.disabled = true;
    try {
      const {error} = await client.auth.resend({type:"signup", email, options:{emailRedirectTo:location.origin + location.pathname}});
      if (error) throw error;
      showToast("Письмо со ссылкой отправлено повторно.");
    } catch (error) { showToast(error.message || "Не удалось отправить письмо.", true); }
    finally { button.disabled = false; }
  });
  $("#backToAuth").addEventListener("click", () => {
    $("#verifyForm").classList.add("hidden");
    $("#authForm").classList.remove("hidden");
    setMode("login");
  });
  $("#resetPassword").addEventListener("click", async () => {
    const email = $("#email").value.trim();
    if (!email) { showToast("Сначала введите email.", true); return; }
    const {error} = await client.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
    if (error) showToast(error.message, true);
    else showToast("Если адрес зарегистрирован, письмо для сброса пароля отправлено.");
  });
  $("#logoutBtn").addEventListener("click", async () => {
    stopSubscriptions();
    const {error} = await client.auth.signOut();
    if (error) showToast(error.message, true);
    showAuth();
  });
  $("#newChatBtn").addEventListener("click", openPeopleDialog);
  $("#findPeopleBtn").addEventListener("click", openPeopleDialog);
  $("#welcomeFindBtn").addEventListener("click", openPeopleDialog);
  $("#chatSearch").addEventListener("input", renderChatList);
  $("#peopleSearch").addEventListener("input", () => {
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(searchPeople, 250);
  });
  $("#composer").addEventListener("submit", sendMessage);
  $("#messageInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#messageInput").addEventListener("input", event => {
    event.target.style.height = "auto";
    event.target.style.height = Math.min(event.target.scrollHeight, 140) + "px";
  });
  $("#refreshBtn").addEventListener("click", async () => {
    await loadMessages(); await refreshConversations(); showToast("Обновлено.");
  });
  $("#backBtn").addEventListener("click", () => appView.classList.remove("chat-open"));
  $("#createSpaceBtn").addEventListener("click", () => { $("#spaceTitle").value=""; $("#spaceMembers").value=""; $("#spaceDialog").showModal(); });
  $("#spaceType").addEventListener("change", () => { $("#spaceMembersLabel").classList.toggle("hidden", $("#spaceType").value === "channel"); });
  $("#spaceForm").addEventListener("submit", async event => {
    event.preventDefault();
    const title = $("#spaceTitle").value.trim(); const type = $("#spaceType").value;
    let memberIds = [];
    if (type === "group") {
      const names = $("#spaceMembers").value.split(",").map(x=>x.trim()).filter(Boolean);
      for (const name of names) {
        const {data} = await client.from("profiles").select("id").ilike("display_name", name).limit(1);
        if (data?.[0]?.id) memberIds.push(data[0].id);
      }
    }
    const {data,error} = await client.rpc("create_community_space", {space_title:title, space_type:type, member_ids:memberIds});
    if (error) { showToast("Не удалось создать: " + error.message, true); return; }
    $("#spaceDialog").close(); await refreshConversations(); await openConversation(data); showToast(type === "channel" ? "Канал создан." : "Группа создана.");
  });
  $("#browseChannelsBtn").addEventListener("click", browseChannels);
  $("#attachBtn").addEventListener("click", () => $("#imageInput").click());
  $("#imageInput").addEventListener("change", async event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !currentConversationId) return;
    if (!file.type.startsWith("image/")) { showToast("Выбери изображение.", true); return; }
    if (file.size > 8*1024*1024) { showToast("Максимальный размер фото — 8 МБ.", true); return; }
    showToast("Загружаю фото…");
    let publicUrl; try { publicUrl=await uploadMedia(file,"image"); } catch(uploadError) { showToast("Не удалось загрузить фото: " + uploadError.message,true); return; }
    const {error} = await client.from("messages").insert({conversation_id:currentConversationId,sender_id:currentUser.id,content:"",attachment_url:publicUrl,attachment_type:"image"});
    if (error) { showToast("Фото загружено, но не отправлено: "+error.message,true); return; }
    await loadMessages(); await refreshConversations(); showToast("Фото отправлено.");
  });
  $("#chatOptionsBtn").addEventListener("click", () => { if (!currentConversationId) return; const item=conversations.find(c=>c.id===currentConversationId); showToast(item ? `${item.type === "channel" ? "Канал" : item.type === "group" ? "Группа" : "Личная переписка"}: ${item.title || item.peer.display_name}` : "Чат"); });
  $("#settingsDialog").querySelectorAll("[data-settings-tab]").forEach(btn => btn.addEventListener("click", () => {
    $("#settingsDialog").querySelectorAll("[data-settings-tab]").forEach(b=>b.classList.toggle("active",b===btn));
    $("#settingsDialog").querySelectorAll("[data-settings-panel]").forEach(panel=>panel.classList.toggle("hidden",panel.dataset.settingsPanel!==btn.dataset.settingsTab));
  }));
  $("#profileBtn").addEventListener("click", () => { loadAppearanceSettings(); $("#settingsDialog").showModal(); });
  $("#openProfileFromSettings").addEventListener("click", () => {
    $("#settingsDialog").close(); if (!currentProfile) return;
    $("#profileName").value=currentProfile.display_name||""; $("#profileBio").value=currentProfile.bio||""; $("#profileEmail").textContent=currentUser.email; setAvatar($("#profileAvatarPreview"),currentProfile.avatar_url,currentProfile.display_name); $("#profileDialog").showModal();
  });
  $("#settingsLogoutBtn").addEventListener("click", async () => { $("#settingsDialog").close(); stopSubscriptions(); await client.auth.signOut(); showAuth(); });
  const savePrefs = () => {
    const prefs={accent:$("#accentSetting").value,compact:$("#compactSetting").checked,motion:$("#motionSetting").checked,sound:$("#soundSetting").checked,bioSearch:$("#bioSearchSetting").checked};
    localStorage.setItem("milchiktg-prefs",JSON.stringify(prefs)); applyAppearance(prefs); showToast("Настройки сохранены в этом браузере.");
  };
  $("#saveAppearanceBtn").addEventListener("click", savePrefs);
  $("#savePrivacyBtn").addEventListener("click", savePrefs);
  $("#saveNotificationsBtn").addEventListener("click", savePrefs);

  $("#avatarInput").addEventListener("change", async event => {
    const file=event.target.files?.[0]; event.target.value=""; if(!file) return;
    if(!file.type.startsWith("image/")){showToast("Выбери изображение.",true);return;}
    try { const url=await uploadMedia(file,"avatar"); const {error}=await client.from("profiles").update({avatar_url:url}).eq("id",currentUser.id); if(error) throw error; await loadMyProfile(); setAvatar($("#profileAvatarPreview"),url,currentProfile.display_name); await refreshConversations(); showToast("Аватар обновлён."); }
    catch(error){showToast("Не удалось обновить аватар: "+error.message,true);}
  });
  $("#peerAvatar").addEventListener("click",()=>{const item=conversations.find(c=>c.id===currentConversationId);if(item?.type==="direct")showPublicProfile(item.peer?.id);});
  $("#peerName").addEventListener("click",()=>{const item=conversations.find(c=>c.id===currentConversationId);if(item?.type==="direct")showPublicProfile(item.peer?.id);});
  $("#publicProfileMessageBtn").addEventListener("click",async()=>{if(!publicProfileTarget)return;const id=publicProfileTarget.id;$("#publicProfileDialog").close();await startConversation(id);});
  $("#voiceBtn").addEventListener("click", async()=>{
    if(recording && recording.state==="recording"){recording.stop();$("#voiceBtn").classList.remove("recording");$("#voiceBtn").textContent="🎙";showToast("Обработка голосового сообщения…");return;}
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){showToast("Запись голоса не поддерживается этим браузером.",true);return;}
    try { const stream=await navigator.mediaDevices.getUserMedia({audio:true}); recordedChunks=[]; recording=new MediaRecorder(stream); recording.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data);}; recording.onstop=async()=>{const blob=new Blob(recordedChunks,{type:recording.mimeType||"audio/webm"});stream.getTracks().forEach(t=>t.stop());recording=null;await sendAudioBlob(blob);}; recording.start(); $("#voiceBtn").classList.add("recording");$("#voiceBtn").textContent="■";showToast("Запись идёт. Нажми ■, чтобы отправить."); }
    catch(error){showToast("Нет доступа к микрофону. Разреши его в браузере.",true);}
  });
  $("#profileForm").addEventListener("submit", saveProfile);
  client.auth.onAuthStateChange(async (event, session) => {
    if (session?.user && !currentUser) await enterApp(session.user);
    if (event === "SIGNED_OUT") showAuth();
  });
  const {data:{session}} = await client.auth.getSession();
  if (session?.user) await enterApp(session.user);
}
init();
