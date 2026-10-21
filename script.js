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
  const {data, error} = await client.from("profiles").select("id, display_name, username, bio, avatar_url, created_at").eq("id", currentUser.id).single();
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

  const messageIds = (messageRows || []).map(row => row.id);
  let readRows = [];
  if (messageIds.length) {
    const readResult = await client.from("message_reads").select("message_id,user_id").in("message_id", messageIds);
    if (!readResult.error) readRows = readResult.data || [];
  }
  const readsByMessage = new Map();
  for (const read of readRows) {
    const key = String(read.message_id);
    if (!readsByMessage.has(key)) readsByMessage.set(key, new Set());
    readsByMessage.get(key).add(read.user_id);
  }
  conversations = ids.map(id => {
    const membership = membershipRows.find(row => row.conversation_id === id);
    const members = (memberRows || []).filter(row => row.conversation_id === id);
    const peerRow = members.find(row => row.user_id !== currentUser.id);
    const peer = peerRow?.profiles || {id: peerRow?.user_id, display_name:"Пользователь"};
    const meta = membership?.conversations || {};
    const chatMessages = (messageRows || []).filter(row => row.conversation_id === id);
    const latest = chatMessages[0];
    const unread = chatMessages.filter(row => row.sender_id !== currentUser.id && !readsByMessage.get(String(row.id))?.has(currentUser.id)).length;
    if (id === currentConversationId) localStorage.setItem(`milchiktg-unread-${id}`, "0");
    else localStorage.setItem(`milchiktg-unread-${id}`, String(unread));
    return {id, type:meta.type || "direct", title:meta.title || "", created_at:meta.created_at, updated_at:latest?.created_at || meta.updated_at, peer, latest, unread, readsByMessage};
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
      <div class="chat-preview">${escapeHTML(preview)}</div></div>${c.unread > 0 && c.id !== currentConversationId ? `<span class="unread-badge">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}</button>`;
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
  await markConversationRead();
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
  let receipts = [];
  const ids = (data || []).filter(m => m.sender_id === currentUser.id).map(m => m.id);
  if (ids.length) {
    const readResult = await client.from("message_reads").select("message_id,user_id,read_at").in("message_id", ids).neq("user_id", currentUser.id);
    if (!readResult.error) receipts = readResult.data || [];
  }
  renderMessages(data || [], receipts);
}
async function markConversationRead() {
  if (!currentUser || !currentConversationId) return;
  const {data, error} = await client.from("messages").select("id").eq("conversation_id", currentConversationId).neq("sender_id", currentUser.id).order("created_at", {ascending:false}).limit(300);
  if (error || !data?.length) { localStorage.setItem(`milchiktg-unread-${currentConversationId}`, "0"); await refreshConversations(); return; }
  const rows = data.map(m => ({message_id:m.id,user_id:currentUser.id}));
  const result = await client.from("message_reads").upsert(rows, {onConflict:"message_id,user_id", ignoreDuplicates:true});
  if (result.error) console.warn("Read receipt error:", result.error.message);
  localStorage.setItem(`milchiktg-unread-${currentConversationId}`, "0");
  await refreshConversations();
}
function renderMessages(rows, receipts = []) {
  messageCache = rows || [];
  const container = $("#messages");
  if (!rows.length) {
    container.innerHTML = '<div class="system-note">Это начало переписки. Напишите первое сообщение.</div>';
    return;
  }
  container.innerHTML = rows.map(m => {
    const mine = m.sender_id === currentUser.id;
    const attachment = m.attachment_url ? (m.attachment_type === "audio" ? `<audio class="message-audio" controls preload="none" playsinline src="${escapeHTML(m.attachment_url)}"></audio><a class="audio-open-link" href="${escapeHTML(m.attachment_url)}" target="_blank" rel="noopener">Открыть аудио отдельно</a>` : `<button class="image-preview-button" type="button" data-view-image="${escapeHTML(m.attachment_url)}" aria-label="Открыть фото"><img class="message-image" src="${escapeHTML(m.attachment_url)}" alt="Фото в сообщении" loading="lazy"></button>`) : "";
    const actions = mine ? `<div class="message-actions"><button data-msg-action="pin" data-msg-id="${m.id}">${m.is_pinned ? "📌 Открепить" : "📌 Закрепить"}</button>${m.content ? `<button data-msg-action="edit" data-msg-id="${m.id}">Изменить</button>` : ""}<button class="message-delete" data-msg-action="delete" data-msg-id="${m.id}">Удалить</button></div>` : "";
    const seen = mine && receipts.some(r => String(r.message_id) === String(m.id));
    return `<article class="message-row ${mine ? "mine" : ""} ${m.is_pinned ? "pinned-message" : ""}"><div class="bubble">${m.is_pinned ? '<div class="pinned-label">📌 Закреплено</div>' : ""}${attachment}${m.content ? `<div>${escapeHTML(m.content)}</div>` : ""}</div><div class="message-meta">${timeLabel(m.created_at)}${m.edited_at ? " · изменено" : ""}${mine ? ` · ${seen ? "✓✓ Прочитано" : "✓ Отправлено"}` : ""}</div>${actions}</article>`;
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
  const {data,error} = await client.from("profiles").select("id, display_name, username, bio, avatar_url, created_at").eq("id",userId).maybeSingle();
  if (error || !data) { showToast("Не удалось загрузить профиль.", true); return; }
  publicProfileTarget = data;
  setAvatar($("#publicProfileAvatar"), data.avatar_url, data.display_name);
  $("#publicProfileName").textContent = data.display_name || "Пользователь";
  $("#publicProfileUsername").textContent = data.username ? "@" + data.username : "";
  $("#publicProfileBio").textContent = data.bio || "Пользователь пока ничего не рассказал о себе.";
  $("#publicProfileMessageBtn").classList.toggle("hidden", data.id === currentUser.id);
  $("#publicProfileDialog").showModal();
}
async function uploadMedia(file, kind) {
  if (!file) return null;
  const maxBytes = (kind === "avatar" ? 5 : 12) * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(kind === "avatar" ? "Аватар должен быть меньше 5 МБ." : "Файл должен быть меньше 12 МБ.");
  if (kind === "voice" && !file.type.startsWith("audio/")) throw new Error("Запись не распознана как аудио.");
  if (kind !== "voice" && !file.type.startsWith("image/")) throw new Error("Выберите файл изображения.");
  const safeName = (file.name || (kind === "voice" ? "voice.webm" : "image.jpg")).replace(/[^a-zA-Z0-9._-]/g,"_");
  const path = `${currentUser.id}/${kind}-${Date.now()}-${safeName}`;
  const bucket = client.storage.from("milchiktg-media");
  const {error} = await bucket.upload(path,file,{upsert:false,contentType:(file.type || (kind === "voice" ? "audio/webm" : "image/jpeg")).split(";")[0],cacheControl:"3600"});
  if (error) throw new Error(error.message + (error.message.toLowerCase().includes("bucket") ? " — проверь, что выполнен единый SQL-файл настройки." : ""));
  const {data} = bucket.getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Не удалось получить ссылку на файл.");
  return data.publicUrl;
}
async function sendAudioBlob(blob, targetConversationId = currentConversationId) {
  if (!targetConversationId || !blob) return;
  if (!blob.size) { showToast("Запись пустая. Попробуй записать ещё раз.", true); return; }
  try {
    showToast("Отправляю голосовое сообщение…");
    const mime = blob.type || "audio/webm";
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : "webm";
    const file = new File([blob], `voice-${Date.now()}.${ext}`, {type:mime});
    const url = await uploadMedia(file,"voice");
    const {error} = await client.from("messages").insert({conversation_id:targetConversationId,sender_id:currentUser.id,content:"",attachment_url:url,attachment_type:"audio"});
    if (error) throw error;
    if (currentConversationId === targetConversationId) await loadMessages();
    await refreshConversations(); showToast("Голосовое сообщение отправлено.");
  } catch(error) { showToast("Не удалось отправить голосовое сообщение: " + error.message,true); }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("#messageInput");
  const content = input.value.trim();
  const targetConversationId = currentConversationId;
  if (!content || !targetConversationId) return;
  const button = $("#sendBtn");
  button.disabled = true;
  try {
    const {error} = await client.from("messages").insert({conversation_id:targetConversationId,sender_id:currentUser.id,content});
    if (error) throw error;
    input.value = "";
    input.style.height = "auto";
    if (currentConversationId === targetConversationId) await loadMessages();
    await refreshConversations();
  } catch(error) { showToast("Сообщение не отправлено: " + error.message, true); }
  finally { button.disabled = false; input.focus(); }
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
      // Own inserts are rendered by the send handler; avoid rerendering media twice.
      if (payload.eventType === "INSERT" && payload.new.sender_id === currentUser.id) { await refreshConversations(); return; }
      await loadMessages();
      if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser.id) { playMessageSound(); await markConversationRead(); }
      await refreshConversations();
    })
    .on("postgres_changes", {event:"INSERT", schema:"public", table:"message_reads", filter:"user_id=neq." + currentUser.id}, async () => {
      await loadMessages();
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
  const safeQuery = query.replace(/[%,()]/g, " ");
  const {data, error} = await client.from("profiles")
    .select("id, display_name, username, bio, avatar_url")
    .neq("id", currentUser.id)
    .or(`display_name.ilike.%${safeQuery}%,username.ilike.%${safeQuery.replace(/^@/, "")}%`)
    .order("display_name")
    .limit(20);
  if (error) { result.innerHTML = `<p class="muted">Ошибка поиска: ${escapeHTML(error.message)}</p>`; return; }
  if (!data?.length) {
    result.innerHTML = '<p class="muted">Никого не нашли. Поиск идёт по отображаемому имени.</p>';
    return;
  }
  result.innerHTML = data.map(person => `<button class="person-result" data-person-id="${person.id}">
    <div class="avatar">${person.avatar_url ? `<img src="${escapeHTML(person.avatar_url)}" alt="">` : escapeHTML(initials(person.display_name))}</div><div class="person-info"><strong>${escapeHTML(person.display_name || "Пользователь")}</strong><span>${person.username ? "@" + escapeHTML(person.username) + " · " : ""}${escapeHTML((JSON.parse(localStorage.getItem("milchiktg-prefs")||"{}").bioSearch === false) ? "Пользователь MilchikTG" : (person.bio || "Пользователь MilchikTG"))}</span></div>
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
  const username = $("#profileUsername").value.trim().toLowerCase().replace(/^@/, "");
  if (!display_name) { showToast("Введите отображаемое имя.", true); return; }
  if (!/^[a-z0-9_]{3,24}$/.test(username)) { showToast("Юзернейм: 3–24 символа, только a–z, цифры и _.", true); return; }
  const {error} = await client.from("profiles").update({display_name, username, bio}).eq("id", currentUser.id);
  if (error) { showToast(error.code === "23505" ? "Этот юзернейм уже занят. Выбери другой." : "Не удалось сохранить профиль: " + error.message, true); return; }
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
  const messagePane = $("#messages");
  messagePane.addEventListener("error", event => {
    if (event.target.matches("audio")) {
      const audio = event.target;
      audio.title = "Не удалось воспроизвести аудио. Попробуйте открыть отдельно.";
      const note = audio.nextElementSibling;
      if (note?.classList.contains("audio-open-link")) note.classList.add("audio-open-error");
    }
  }, true);
  messagePane.addEventListener("contextmenu", event => {
    const row = event.target.closest(".message-row");
    if (!row) return;
    event.preventDefault();
    messagePane.querySelectorAll(".message-row.show-actions").forEach(el => el.classList.remove("show-actions"));
    row.classList.add("show-actions");
  });
  messagePane.addEventListener("click", event => {
    const imageButton = event.target.closest("[data-view-image]");
    if (imageButton) { event.stopPropagation(); const image = $("#imageLightboxImg"); image.src = imageButton.dataset.viewImage; $("#imageLightbox").showModal(); return; }
    if (event.target.closest("[data-msg-action]") || event.target.closest("a, audio")) return;
    const row = event.target.closest(".message-row");
    if (!row) { messagePane.querySelectorAll(".show-actions").forEach(el => el.classList.remove("show-actions")); return; }
    const wasOpen = row.classList.contains("show-actions");
    messagePane.querySelectorAll(".message-row.show-actions").forEach(el => el.classList.remove("show-actions"));
    if (!wasOpen) row.classList.add("show-actions");
  });
  document.addEventListener("click", event => {
    if (!event.target.closest("#messages")) messagePane.querySelectorAll(".message-row.show-actions").forEach(el => el.classList.remove("show-actions"));
  });
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
    const targetConversationId = currentConversationId;
    if (!file || !targetConversationId) return;
    if (!file.type.startsWith("image/")) { showToast("Выбери изображение.", true); return; }
    if (file.size > 8*1024*1024) { showToast("Максимальный размер фото — 8 МБ.", true); return; }
    showToast("Загружаю фото…");
    let publicUrl; try { publicUrl=await uploadMedia(file,"image"); } catch(uploadError) { showToast("Не удалось загрузить фото: " + uploadError.message,true); return; }
    const {error} = await client.from("messages").insert({conversation_id:targetConversationId,sender_id:currentUser.id,content:"",attachment_url:publicUrl,attachment_type:"image"});
    if (error) { showToast("Фото загружено, но не отправлено: "+error.message,true); return; }
    if (currentConversationId === targetConversationId) await loadMessages();
    await refreshConversations(); showToast("Фото отправлено.");
  });
  $("#chatOptionsBtn").addEventListener("click", () => { if (!currentConversationId) return; const item=conversations.find(c=>c.id===currentConversationId); showToast(item ? `${item.type === "channel" ? "Канал" : item.type === "group" ? "Группа" : "Личная переписка"}: ${item.title || item.peer.display_name}` : "Чат"); });
  $("#settingsDialog").querySelectorAll("[data-settings-tab]").forEach(btn => btn.addEventListener("click", () => {
    $("#settingsDialog").querySelectorAll("[data-settings-tab]").forEach(b=>b.classList.toggle("active",b===btn));
    $("#settingsDialog").querySelectorAll("[data-settings-panel]").forEach(panel=>panel.classList.toggle("hidden",panel.dataset.settingsPanel!==btn.dataset.settingsTab));
  }));
  $("#profileBtn").addEventListener("click", () => { loadAppearanceSettings(); $("#settingsDialog").showModal(); });
  $("#openProfileFromSettings").addEventListener("click", () => {
    $("#settingsDialog").close(); if (!currentProfile) return;
    $("#profileName").value=currentProfile.display_name||""; $("#profileUsername").value=currentProfile.username||""; $("#profileBio").value=currentProfile.bio||""; $("#profileEmail").textContent=currentUser.email; setAvatar($("#profileAvatarPreview"),currentProfile.avatar_url,currentProfile.display_name); $("#profileDialog").showModal();
  });
  $("#settingsLogoutBtn").addEventListener("click", async () => { $("#settingsDialog").close(); stopSubscriptions(); await client.auth.signOut(); showAuth(); });
  const savePrefs = () => {
    const prefs={accent:$("#accentSetting").value,compact:$("#compactSetting").checked,motion:$("#motionSetting").checked,sound:$("#soundSetting").checked,bioSearch:$("#bioSearchSetting").checked};
    localStorage.setItem("milchiktg-prefs",JSON.stringify(prefs)); applyAppearance(prefs); showToast("Настройки сохранены в этом браузере.");
  };
  $("#saveAppearanceBtn").addEventListener("click", savePrefs);
  $("#savePrivacyBtn").addEventListener("click", savePrefs);
  $("#saveNotificationsBtn").addEventListener("click", savePrefs);
  $("#installAppBtn").addEventListener("click", async () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      await installPromptEvent.userChoice;
      installPromptEvent = null;
    } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      showToast("На iPhone нажми «Поделиться» в Safari → «На экран Домой».");
    } else {
      showToast("Если установка не предлагается: открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».");
    }
  });

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
    if(!currentConversationId){showToast("Сначала открой переписку.",true);return;}
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){showToast("Запись голоса не поддерживается. Открой сайт в актуальном браузере по HTTPS.",true);return;}
    let stream;
    const recordingConversationId = currentConversationId;
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
      recordedChunks=[];
      const types=["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg;codecs=opus"];
      const supported=types.find(type=>MediaRecorder.isTypeSupported?.(type));
      const recorderInstance=supported ? new MediaRecorder(stream,{mimeType:supported}) : new MediaRecorder(stream);
      recording=recorderInstance;
      recorderInstance.ondataavailable=e=>{if(e.data?.size)recordedChunks.push(e.data);};
      recorderInstance.onerror=()=>{stream.getTracks().forEach(t=>t.stop());recording=null;$("#voiceBtn").classList.remove("recording");$("#voiceBtn").textContent="🎙";showToast("Ошибка записи. Проверь доступ к микрофону.",true);};
      recorderInstance.onstop=async()=>{
        const mime=recorderInstance.mimeType || recordedChunks[0]?.type || "audio/webm";
        const blob=new Blob(recordedChunks,{type:mime});
        stream.getTracks().forEach(t=>t.stop());
        if(recording===recorderInstance)recording=null;
        $("#voiceBtn").classList.remove("recording");$("#voiceBtn").textContent="🎙";
        await sendAudioBlob(blob, recordingConversationId);
      };
      recorderInstance.start(250);
      $("#voiceBtn").classList.add("recording");$("#voiceBtn").textContent="■";showToast("Запись идёт. Нажми ■, чтобы отправить.");
    } catch(error){stream?.getTracks().forEach(t=>t.stop());recording=null;$("#voiceBtn").classList.remove("recording");$("#voiceBtn").textContent="🎙";showToast("Не удалось включить микрофон. Разреши доступ в браузере: "+(error.message||"доступ запрещён"),true);}
  });
  $("#imageLightboxClose").addEventListener("click", () => $("#imageLightbox").close());
  $("#imageLightbox").addEventListener("click", event => { if (event.target === $("#imageLightbox")) $("#imageLightbox").close(); });
  $("#profileForm").addEventListener("submit", saveProfile);
  client.auth.onAuthStateChange(async (event, session) => {
    if (session?.user && !currentUser) await enterApp(session.user);
    if (event === "SIGNED_OUT") showAuth();
  });
  const {data:{session}} = await client.auth.getSession();
  if (session?.user) await enterApp(session.user);
}
let installPromptEvent = null;
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPromptEvent = event; const button=$("#installAppBtn"); if(button) button.textContent="Установить MilchikTG"; });
window.addEventListener("appinstalled", () => { installPromptEvent=null; showToast("MilchikTG установлен."); });
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

init();
