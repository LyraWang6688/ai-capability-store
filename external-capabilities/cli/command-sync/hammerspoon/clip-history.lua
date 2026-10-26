-- clip-history：系统剪贴板历史（只存文本），⌥X 面板的数据源
--
-- 为什么要有它：macOS 的 pasteboard 只有一格，没有历史 —— 剪贴板被下一次复制
-- 覆盖后，系统层就彻底丢了（⌘X 剪切的内容也一样，剪切只是「复制 + 删除原文」）。
-- 这里用 hs.pasteboard.watcher 监听变化，每次变化追加一行 JSONL 落盘，
-- 面板（command-palette.lua）打开时读最近 N 条。
--
-- 为什么不用 hs.clipboard：Hammerspoon 1.1.1 里没有这个模块（求值得到 nil），
-- 剪贴板监听在 hs.pasteboard.watcher 里，内部是 0.25s 轮询 changeCount。
-- 回调参数实测就是新文本内容（string）；非文本（图片/文件）给 nil，这里直接跳过。
--
-- 契约（唯一）：
--   文件 ~/.hammerspoon/clipboard-history.jsonl，一行一条 {"t":<epoch>,"text":"..."}，
--   按时间升序追加；读取时按行序倒排成「新→旧」。
--   消费方只用 require("clip-history").recent(n)。
--
-- 隐私（重要）：
--   1Password 这类密码管理器复制密码时会给粘贴板打
--   org.nspasteboard.ConcealedType 标记 —— 带这个标记（含 TransientType）的一律不记录。
--   但不是所有 App 都会打，剪贴板历史不等于密码保险箱。
--   单条超 20k 字节截断；最多留 100 条；文件超过 400 行压缩重写一次。

local M = {}

local HOME = os.getenv("HOME") or ""
local DIR = hs.configdir or (HOME .. "/.hammerspoon")
local FILE = DIR .. "/clipboard-history.jsonl"

local MAX_ENTRIES = 100
local MAX_TEXT_BYTES = 20000
local MAX_FILE_LINES = 400

local CONCEALED = {
  ["org.nspasteboard.ConcealedType"] = true,
  ["org.nspasteboard.TransientType"] = true,
}

local entries   -- 新 → 旧；nil = 还没读过盘
local linesOnDisk = 0   -- 文件里现有行数（压缩重写的阈值按它算，不按本次会话追加数）

-- 按字节截断，但不切断 UTF-8 字符
local function trunc_bytes(s, maxbytes)
  if #s <= maxbytes then return s end
  local cut = maxbytes
  while cut > 0 and not utf8.len(s, 1, cut) do cut = cut - 1 end
  return s:sub(1, cut)
end

-- 压成一行：预览和搜索用（复制出去的仍是原文）
local function oneline(s, maxbytes)
  local t = s:gsub("\r\n", " "):gsub("[\r\n\t]", " "):gsub("%s%s+", " ")
  t = t:gsub("^%s+", ""):gsub("%s+$", "")
  return trunc_bytes(t, maxbytes)
end

local function nchars(s)
  return utf8.len(s) or #s
end

local function relative(epoch)
  local d = os.time() - (epoch or 0)
  if d < 0 then d = 0 end
  if d < 60 then return "刚刚" end
  if d < 3600 then return ("%d 分钟前"):format(math.floor(d / 60)) end
  if d < 86400 then return ("%d 小时前"):format(math.floor(d / 3600)) end
  return os.date("%m-%d %H:%M", epoch)
end

local function load()
  entries = {}
  linesOnDisk = 0
  local fh = io.open(FILE, "r")
  if not fh then return end
  local seen = {}
  for line in fh:lines() do
    if line ~= "" then
      linesOnDisk = linesOnDisk + 1
      local ok, rec = pcall(hs.json.decode, line)
      if ok and type(rec) == "table" and type(rec.text) == "string" and rec.text ~= "" then
        if not seen[rec.text] then
          seen[rec.text] = true
          table.insert(entries, 1, { t = tonumber(rec.t) or 0, text = rec.text })
        end
      end
    end
  end
  fh:close()
  while #entries > MAX_ENTRIES do entries[#entries] = nil end
end

local function rewrite()
  local fh = io.open(FILE, "w")
  if not fh then return end
  for i = #entries, 1, -1 do          -- 旧 → 新写回，文件依然是「追加即时间序」
    fh:write(hs.json.encode({ t = entries[i].t, text = entries[i].text }), "\n")
  end
  fh:close()
  linesOnDisk = #entries
end

local function record(text)
  if not entries then load() end
  text = text:gsub("\r\n", "\n")
  if text == "" then return end
  if #text > MAX_TEXT_BYTES then
    text = trunc_bytes(text, MAX_TEXT_BYTES) .. "\n…（超过 20k，已截断）"
  end
  -- 同一内容反复写粘贴板（比如面板里再点一次），不算新记录
  if entries[1] and entries[1].text == text then return end
  -- 内容原来就在历史里：提到最前，而不是留两行
  for i = #entries, 1, -1 do
    if entries[i].text == text then table.remove(entries, i) break end
  end
  table.insert(entries, 1, { t = os.time(), text = text })
  while #entries > MAX_ENTRIES do entries[#entries] = nil end

  local fh = io.open(FILE, "a")
  if fh then
    fh:write(hs.json.encode({ t = entries[1].t, text = text }), "\n")
    fh:close()
    linesOnDisk = linesOnDisk + 1
    if linesOnDisk > MAX_FILE_LINES then rewrite() end
  end
end

local function concealed()
  local ok, types = pcall(hs.pasteboard.contentTypes)
  if not ok or type(types) ~= "table" then return false end
  for _, ty in ipairs(types) do
    if CONCEALED[ty] then return true end
  end
  return false
end

-- ── 对外 API ─────────────────────────────────────────────────────────────

function M.file() return FILE end

function M.count()
  if not entries then load() end
  return #entries
end

--- 最近 limit 条，新 → 旧。每条已经是面板 item 的形状。
function M.recent(limit)
  if not entries then load() end
  local out = {}
  for i, e in ipairs(entries) do
    if limit and i > limit then break end
    out[i] = {
      id = "clip-" .. i,
      kind = "clip",
      title = oneline(e.text, 240),                                  -- 面板主行：一行预览
      command = ("%s · %d 字"):format(relative(e.t), nchars(e.text)), -- 面板副行：时间 + 字数
      text = e.text,                                                 -- 选中后复制的原文
      search = oneline(e.text, 800),                                 -- 搜索用，比主行长
    }
  end
  return out
end

--- 手动清空（面板不暴露，留给人调试）
function M.clear()
  entries = {}
  rewrite()
  return true
end

M._watcher = hs.pasteboard.watcher.new(function(contents)
  if type(contents) ~= "string" or contents == "" then return end
  if concealed() then return end
  local ok = pcall(record, contents)
  if not ok then hs.alert.show("剪贴板历史写入失败") end
end)

return M
