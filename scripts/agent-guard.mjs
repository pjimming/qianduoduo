#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(scriptDir, '..');
export const DEFAULT_GUARD_ROOT = path.join(PROJECT_ROOT, 'run', 'agent-guard');

export const AGENT_POLICIES = Object.freeze({
  explorer: Object.freeze({
    category: 'exploration',
    wallClockMinutes: 10,
    toolCallBudget: 30,
  }),
  workspace_explorer: Object.freeze({
    category: 'exploration',
    wallClockMinutes: 10,
    toolCallBudget: 30,
  }),
  default: Object.freeze({
    category: 'implementation',
    wallClockMinutes: 30,
    toolCallBudget: 80,
  }),
  worker: Object.freeze({
    category: 'implementation',
    wallClockMinutes: 30,
    toolCallBudget: 80,
  }),
  backend_integrity_worker: Object.freeze({
    category: 'implementation',
    wallClockMinutes: 30,
    toolCallBudget: 80,
  }),
  ui_quality_worker: Object.freeze({
    category: 'implementation',
    wallClockMinutes: 30,
    toolCallBudget: 80,
  }),
  delivery_reviewer: Object.freeze({
    category: 'review',
    wallClockMinutes: 20,
    toolCallBudget: 50,
  }),
  stock_research_analyst: Object.freeze({
    category: 'research',
    wallClockMinutes: 45,
    toolCallBudget: 120,
  }),
});

const REQUIRED_BRIEF_FIELDS = [
  '目标',
  '用户原始要求',
  '研究/执行截止',
  '当前工作目录',
  '必须读取',
  '可读范围',
  '可写范围',
  '禁止事项',
  '交付格式',
  '验证命令或证据',
  '完成条件',
  '阻塞时返回',
];

const REQUIRED_FINAL_SECTIONS = [
  ['已完成', /已完成\s*[:：]/u],
  ['未完成', /未完成\s*[:：]/u],
  ['可恢复状态', /可恢复状态\s*[:：]/u],
  ['剩余风险', /剩余风险\s*[:：]/u],
];

const CLOSING_CONTEXT = [
  '运行防护已进入 80% 收口闸门。',
  '禁止启动新调研、扩大范围、写入实现或改写交付物；只允许读取现有证据并整理部分结果。',
  '下一次可能冻结全部工具调用，请直接准备最终答复。',
].join('');

const FINAL_FORMAT_REASON = [
  '最终答复格式不合规。首行必须使用简报中的准确 TASK_ID；',
  '随后必须逐字写出“目标复述：<简报目标>”以及已完成：、未完成：、可恢复状态：、剩余风险：。',
  '不得调用工具，只整理当前已有结果。',
].join('');

function normalizeAgentType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_');
}

function resolvePolicy(agentType) {
  const normalized = normalizeAgentType(agentType);
  const specific = AGENT_POLICIES[normalized];

  if (specific) {
    return {
      agentType: normalized,
      known: true,
      ...specific,
    };
  }

  return {
    agentType: normalized || 'default',
    known: false,
    ...AGENT_POLICIES.default,
  };
}

function safeHash(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isoMinutesFrom(now, minutes) {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function countLabels(text) {
  return REQUIRED_BRIEF_FIELDS.filter((label) =>
    new RegExp(`^\\s*-\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]`, 'mu').test(text),
  );
}

function extractBriefGoal(text) {
  const match = text.match(/^\s*-\s*目标\s*[:：]\s*(.+?)\s*$/mu);
  return match ? match[1].trim() : '';
}

function extractGuardMetadata(text) {
  const match = text.match(/<!--\s*agent-guard\s*([\s\S]*?)-->/u);
  if (!match) {
    return {
      metadata: null,
      error: '缺少 <!-- agent-guard ... --> 机器可读防护配置',
    };
  }

  const metadata = parseJson(match[1].trim());
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {
      metadata: null,
      error: 'agent-guard 配置必须是合法 JSON 对象',
    };
  }

  return { metadata, error: null };
}

export function validateBriefText(text, options = {}) {
  const {
    filename = '',
    now = new Date(),
  } = options;
  const errors = [];
  const warnings = [];
  const { metadata, error } = extractGuardMetadata(text);
  const goal = extractBriefGoal(text);

  if (error) {
    errors.push(error);
  }
  if (!goal) {
    errors.push('目标必须是非空单行文本');
  }

  const missingLabels = REQUIRED_BRIEF_FIELDS.filter((label) => !countLabels(text).includes(label));
  if (missingLabels.length > 0) {
    errors.push(`任务简报缺少字段：${missingLabels.join('、')}`);
  }

  if (!metadata) {
    return {
      ok: false,
      errors,
      warnings,
      metadata: null,
      policy: null,
      goal,
    };
  }

  const requiredMetadata = [
    'task_id',
    'agent_type',
    'task_kind',
    'hard_deadline',
    'wall_clock_minutes',
    'tool_call_budget',
    'checkpoint_1_pct',
    'checkpoint_2_pct',
    'closeout_pct',
    'recursion_allowed',
  ];

  for (const key of requiredMetadata) {
    if (!(key in metadata)) {
      errors.push(`agent-guard 配置缺少 ${key}`);
    }
  }

  const taskId = String(metadata.task_id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/u.test(taskId)) {
    errors.push('task_id 必须为 3–80 位字母、数字、下划线或连字符');
  }

  if (filename) {
    const baseName = path.basename(filename, path.extname(filename));
    if (taskId && baseName !== taskId) {
      errors.push(`task_id 必须与简报文件名一致：${taskId}.md`);
    }
    if (path.extname(filename).toLowerCase() !== '.md') {
      errors.push('任务简报必须是 .md 文件');
    }
  }

  const policy = resolvePolicy(metadata.agent_type);
  if (!policy.known) {
    errors.push(`未知 agent_type：${metadata.agent_type || '(空)'}`);
  }

  if (String(metadata.task_kind || '') !== policy.category) {
    errors.push(`task_kind 必须为 ${policy.category}`);
  }

  const deadlineMs = Date.parse(String(metadata.hard_deadline || ''));
  if (!Number.isFinite(deadlineMs)) {
    errors.push('hard_deadline 必须是带时区的 ISO 8601 时间');
  } else if (!/(?:Z|[+-]\d{2}:\d{2})$/iu.test(String(metadata.hard_deadline))) {
    errors.push('hard_deadline 必须显式包含时区');
  } else if (deadlineMs <= now.getTime()) {
    errors.push('hard_deadline 必须晚于当前时间');
  }

  if (Number(metadata.wall_clock_minutes) !== policy.wallClockMinutes) {
    errors.push(
      `${policy.agentType} 的 wall_clock_minutes 必须为 ${policy.wallClockMinutes}，以保证运行时硬上限与简报一致`,
    );
  }

  if (Number(metadata.tool_call_budget) !== policy.toolCallBudget) {
    errors.push(
      `${policy.agentType} 的 tool_call_budget 必须为 ${policy.toolCallBudget}，以保证运行时硬上限与简报一致`,
    );
  }

  if (Number(metadata.checkpoint_1_pct) !== 40) {
    errors.push('checkpoint_1_pct 必须为 40');
  }
  if (Number(metadata.checkpoint_2_pct) !== 70) {
    errors.push('checkpoint_2_pct 必须为 70');
  }
  if (Number(metadata.closeout_pct) !== 80) {
    errors.push('closeout_pct 必须为 80');
  }
  if (metadata.recursion_allowed !== false) {
    errors.push('recursion_allowed 必须为 false；需要拆分时由主 Agent 建立新 TASK_ID');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metadata,
    policy,
    goal,
  };
}

export function buildBriefTemplate(options = {}) {
  const {
    taskId = 'DOMAIN-TOPIC-YYYYMMDD-01',
    agentType = 'workspace_explorer',
    objective = '填写本次单一边界任务目标',
    now = new Date(),
  } = options;
  const policy = resolvePolicy(agentType);
  const metadata = {
    task_id: taskId,
    agent_type: policy.agentType,
    task_kind: policy.category,
    hard_deadline: isoMinutesFrom(now, policy.wallClockMinutes),
    wall_clock_minutes: policy.wallClockMinutes,
    tool_call_budget: policy.toolCallBudget,
    checkpoint_1_pct: 40,
    checkpoint_2_pct: 70,
    closeout_pct: 80,
    recursion_allowed: false,
  };

  return `# ${taskId}

<!-- agent-guard
${JSON.stringify(metadata, null, 2)}
-->

- 目标：${objective}
- 用户原始要求：填写与当前任务直接相关的原始要求。
- 研究/执行截止：${metadata.hard_deadline}；从子 Agent 启动时开始计算 ${policy.wallClockMinutes} 分钟硬上限。
- 当前工作目录：${PROJECT_ROOT}
- 必须读取：AGENTS.md、.codex/agents/TASK_PROTOCOL.md、本简报及任务直接相关文件。
- 可读范围：填写允许读取的目录或文件。
- 可写范围：填写唯一允许写入的路径；只读任务写“无”。
- 禁止事项：禁止调用 spawn_agent；禁止扩大范围；禁止触碰真实账本、生产重启或其他 Agent 的写入路径。
- 交付格式：证据、文件、命令结果、已完成、未完成、可恢复状态、剩余风险。
- 验证命令或证据：填写最小充分验证。
- 完成条件：填写可判定完成的单一结果。
- 阻塞时返回：说明阻塞事实、已保留状态、需要主 Agent 决定的事项。

## 运行防护

- 工具调用达到 40% 时执行第一次进度检查。
- 工具调用达到 70% 时执行第二次进度检查，停止扩展范围。
- 时间或工具调用达到 80% 时进入收口，只整理已有证据和部分结果。
- 达到 100% 预算或硬截止时间后，运行防护拒绝全部工具调用。
- 主 Agent 使用 5–10 分钟有界等待；到硬截止时间仍运行时立即调用 \`interrupt_agent\`。
`;
}

function stateFile(guardRoot, stateKey) {
  return path.join(guardRoot, 'states', `${stateKey}.json`);
}

function callsDir(guardRoot, stateKey) {
  return path.join(guardRoot, 'calls', stateKey);
}

function checkpointsDir(guardRoot, stateKey) {
  return path.join(guardRoot, 'checkpoints', stateKey);
}

function reservationsDir(guardRoot) {
  return path.join(guardRoot, 'reservations');
}

function reservationFile(guardRoot, taskId) {
  return path.join(reservationsDir(guardRoot), `${taskId}.json`);
}

const RESERVATION_TTL_MS = 2 * 60_000;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempFile, file);
}

async function createMarker(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function countJsonFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

export async function createBriefReservation(options) {
  const {
    guardRoot = process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT,
    briefPath,
    validation,
    now = new Date(),
  } = options || {};

  if (!validation?.ok || !validation.metadata || !validation.goal || !briefPath) {
    throw new Error('只能为已通过校验且包含目标的任务简报建立 reservation');
  }

  const taskId = String(validation.metadata.task_id);
  const file = reservationFile(guardRoot, taskId);
  const existing = await readJson(file);
  const directory = reservationsDir(guardRoot);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${taskId}.json`) {
      continue;
    }
    const otherFile = path.join(directory, entry.name);
    const other = await readJson(otherFile);
    if (!other) {
      continue;
    }
    if (Date.parse(other.expiresAt) <= now.getTime()) {
      if (!other.claimedBy) {
        await rm(otherFile, { force: true });
      }
      continue;
    }
    if (!other.claimedBy && other.agentType === validation.policy.agentType) {
      throw new Error(
        `已有待派发 reservation ${other.taskId}（${other.agentType}）。先派发或运行 npm run agent:reservation:cancel -- ${other.taskId}，再校验新简报。`,
      );
    }
  }
  const existingClaimAge = existing?.claimedAt
    ? now.getTime() - Date.parse(existing.claimedAt)
    : Number.POSITIVE_INFINITY;
  if (
    existing?.claimedBy
    && Number.isFinite(existingClaimAge)
    && existingClaimAge < (Number(existing.wallClockMinutes || 0) + 5) * 60_000
  ) {
    throw new Error(`TASK_ID ${taskId} 已被运行中的子 Agent 占用，不能重复建立 reservation`);
  }

  const reservation = {
    version: 1,
    taskId,
    agentType: validation.policy.agentType,
    category: validation.policy.category,
    expectedGoal: validation.goal,
    hardDeadline: String(validation.metadata.hard_deadline),
    wallClockMinutes: Number(validation.metadata.wall_clock_minutes),
    toolCallBudget: Number(validation.metadata.tool_call_budget),
    briefPath: path.resolve(briefPath),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
    claimedBy: null,
    claimedAt: null,
    sessionId: null,
  };
  await writeJsonAtomic(file, reservation);
  return reservation;
}

export async function cancelBriefReservation(options) {
  const {
    guardRoot = process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT,
    taskId,
  } = options || {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/u.test(String(taskId || ''))) {
    throw new Error('cancel-reservation 需要合法 TASK_ID');
  }
  const file = reservationFile(guardRoot, taskId);
  const reservation = await readJson(file);
  if (!reservation) {
    return false;
  }
  if (reservation.claimedBy) {
    throw new Error(`TASK_ID ${taskId} 已被 Agent ${reservation.claimedBy} 占用，不能取消 reservation`);
  }
  assertSafeGuardPath(guardRoot, file);
  await rm(file, { force: true });
  return true;
}

async function claimBriefReservation(guardRoot, agentType, event, now) {
  const directory = reservationsDir(guardRoot);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const file = path.join(directory, entry.name);
    const reservation = await readJson(file);
    if (!reservation || reservation.claimedBy || reservation.agentType !== agentType) {
      continue;
    }
    if (Date.parse(reservation.expiresAt) <= now.getTime()) {
      continue;
    }
    candidates.push({ file, reservation });
  }
  candidates.sort((a, b) => a.reservation.createdAt.localeCompare(b.reservation.createdAt));

  for (const candidate of candidates) {
    const lockFile = `${candidate.file}.lock`;
    if (!await createMarker(lockFile, {
      agentId: event.agent_id,
      claimedAt: now.toISOString(),
    })) {
      continue;
    }

    try {
      const latest = await readJson(candidate.file);
      if (!latest || latest.claimedBy || latest.agentType !== agentType) {
        continue;
      }
      if (Date.parse(latest.expiresAt) <= now.getTime()) {
        continue;
      }
      const claimed = {
        ...latest,
        claimedBy: String(event.agent_id),
        claimedAt: now.toISOString(),
        sessionId: String(event.session_id || ''),
      };
      await writeJsonAtomic(candidate.file, claimed);
      return claimed;
    } finally {
      await rm(lockFile, { force: true });
    }
  }

  return null;
}

function getStateKey(event) {
  return safeHash(String(event.session_id || ''), String(event.agent_id || ''));
}

function startContext(state) {
  if (!state.briefVerified) {
    return [
      '子 Agent 运行防护未找到有效期内的已校验任务简报 reservation。',
      '所有工具调用将被拒绝；不要继续执行任务，立即回报简报缺失或 reservation 已过期。',
      '主 Agent 必须重新运行 npm run agent:brief，并在 2 分钟内重新派发。',
    ].join('');
  }

  return [
    `子 Agent 运行防护已启用：${state.taskId}，${state.agentType}，墙钟上限 ${state.wallClockMinutes} 分钟，`,
    `工具调用预算 ${state.toolCallBudget} 次，硬截止 ${state.hardDeadline}。`,
    `目标复述必须逐字匹配：${state.expectedGoal}`,
    '禁止调用 spawn_agent；需要继续拆分时只向主 Agent 回报，由主 Agent 使用新 TASK_ID 单独派发。',
    '工具进度到 40% 和 70% 时会收到检查点，到 80% 进入收口，到 100% 或截止时间后工具冻结。',
    `最终答复首行必须是 CONTEXT_OK ${state.taskId}；随后写出“目标复述：${state.expectedGoal}”及四项收口。`,
  ].join('');
}

export async function handleSubagentStart(event, options = {}) {
  const guardRoot = options.guardRoot || process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT;
  const now = options.now || new Date();
  const agentId = String(event.agent_id || '').trim();
  const sessionId = String(event.session_id || '').trim();

  if (!agentId || !sessionId) {
    return {
      exitCode: 0,
      output: {
        systemMessage: 'agent-guard: SubagentStart 缺少 agent_id/session_id，无法建立运行预算。',
      },
    };
  }

  const policy = resolvePolicy(event.agent_type);
  const key = getStateKey(event);
  const file = stateFile(guardRoot, key);
  let state = await readJson(file);

  if (!state) {
    const reservation = options.reservation
      || await claimBriefReservation(guardRoot, policy.agentType, event, now);
    const reservationMatches = reservation?.agentType === policy.agentType;
    const briefDeadlineMs = reservationMatches ? Date.parse(reservation.hardDeadline) : Number.POSITIVE_INFINITY;
    const policyDeadlineMs = now.getTime() + policy.wallClockMinutes * 60_000;
    const effectiveDeadlineMs = Math.min(
      Number.isFinite(briefDeadlineMs) ? briefDeadlineMs : Number.POSITIVE_INFINITY,
      policyDeadlineMs,
    );
    state = {
      version: 2,
      sessionId,
      agentId,
      agentType: policy.agentType,
      category: policy.category,
      model: String(event.model || ''),
      startedAt: now.toISOString(),
      hardDeadline: new Date(effectiveDeadlineMs).toISOString(),
      wallClockMinutes: policy.wallClockMinutes,
      toolCallBudget: policy.toolCallBudget,
      checkpointPcts: [40, 70, 80],
      taskId: reservationMatches ? reservation.taskId : null,
      expectedGoal: reservationMatches ? reservation.expectedGoal : null,
      briefPath: reservationMatches ? reservation.briefPath : null,
      briefVerified: reservationMatches,
    };
    await writeJsonAtomic(file, state);
  }

  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: startContext(state),
      },
    },
  };
}

function isSpawnTool(toolName) {
  return /(?:^|[.:])spawn_agent$/iu.test(String(toolName || '')) || toolName === 'Agent';
}

function isAllowedDuringCloseout(toolName, toolInput) {
  const name = String(toolName || '');
  if (isSpawnTool(name)) {
    return false;
  }
  if (/^(?:apply_patch|Edit|Write)$/iu.test(name)) {
    return false;
  }
  if (name === 'Bash') {
    return false;
  }
  if (/web|browser|computer|navigate|open.?url|fetch/iu.test(name)) {
    return false;
  }
  if (/read|list|search|grep|glob|find|inspect|status|diff/iu.test(name)
    && !/write|edit|patch|create|delete|remove|move|rename|spawn/iu.test(name)) {
    return true;
  }

  return false;
}

function denyPreTool(reason) {
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    },
  };
}

function allowPreTool(contexts = []) {
  if (contexts.length === 0) {
    return { exitCode: 0, output: null };
  }

  return {
    exitCode: 0,
    output: {
      systemMessage: contexts[0],
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contexts.join('\n'),
      },
    },
  };
}

async function checkpointContexts(state, guardRoot, key, progress, now) {
  const contexts = [];
  const checkpoints = [
    {
      pct: 40,
      message: [
        '检查点 1（40%）：说明当前已获得的事实、尚未完成项和下一验证；',
        '若剩余工作量明显超过余下预算，立即收窄到最小交付。',
      ].join(''),
    },
    {
      pct: 70,
      message: [
        '检查点 2（70%）：停止扩展范围，只完成必要的关键验证；',
        '不再新增候选、模块或非核心证据。',
      ].join(''),
    },
    {
      pct: 80,
      message: CLOSING_CONTEXT,
    },
  ];

  for (const checkpoint of checkpoints) {
    if (progress * 100 < checkpoint.pct) {
      continue;
    }
    const marker = path.join(checkpointsDir(guardRoot, key), `${checkpoint.pct}.json`);
    if (await createMarker(marker, {
      pct: checkpoint.pct,
      reachedAt: now.toISOString(),
    })) {
      contexts.push(checkpoint.message);
    }
  }

  return contexts;
}

export async function handlePreToolUse(event, options = {}) {
  const guardRoot = options.guardRoot || process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT;
  const now = options.now || new Date();
  const agentId = String(event.agent_id || '').trim();

  if (!agentId) {
    return { exitCode: 0, output: null };
  }

  const key = getStateKey(event);
  const state = await readJson(stateFile(guardRoot, key));
  if (!state) {
    return denyPreTool(
      'agent-guard 未找到本子 Agent 的运行状态，拒绝继续调用工具。请立即收口并回报恢复状态。',
    );
  }
  if (!state.briefVerified) {
    return denyPreTool(
      'agent-guard 未找到有效期内且已校验的任务简报，拒绝全部工具调用。请回报 reservation 缺失或过期，由主 Agent 重新校验并派发。',
    );
  }

  const toolName = String(event.tool_name || '');
  const toolUseId = String(event.tool_use_id || `${event.turn_id || 'turn'}-${Date.now()}`);
  await createMarker(
    path.join(callsDir(guardRoot, key), `${safeHash(toolUseId)}.json`),
    {
      toolName,
      toolUseId,
      calledAt: now.toISOString(),
    },
  );

  const callCount = await countJsonFiles(callsDir(guardRoot, key));
  const startedAtMs = Date.parse(state.startedAt);
  const deadlineMs = Date.parse(state.hardDeadline);
  const timeWindowMs = Math.max(
    1,
    Math.min(state.wallClockMinutes * 60_000, deadlineMs - startedAtMs),
  );
  const elapsedRatio = Math.max(0, now.getTime() - startedAtMs) / timeWindowMs;
  const callRatio = callCount / state.toolCallBudget;
  const progress = Math.max(elapsedRatio, callRatio);

  if (isSpawnTool(toolName)) {
    return denyPreTool(
      '子 Agent 默认禁止调用 spawn_agent。需要继续拆分时，请在最终状态中回报，由主 Agent 使用新 TASK_ID 单独派发。',
    );
  }

  if (now.getTime() >= deadlineMs) {
    return denyPreTool(
      `已到硬截止 ${state.hardDeadline}，全部工具冻结。立即输出 CONTEXT_OK、目标复述及四项收口状态。`,
    );
  }

  if (callCount > state.toolCallBudget) {
    return denyPreTool(
      `工具调用预算 ${state.toolCallBudget} 次已用尽，全部工具冻结。立即输出四项收口状态。`,
    );
  }

  const contexts = await checkpointContexts(state, guardRoot, key, progress, now);
  if (progress >= 0.8 && !isAllowedDuringCloseout(toolName, event.tool_input)) {
    return denyPreTool(
      `已达到 ${Math.min(100, Math.floor(progress * 100))}% 预算，进入收口。禁止 shell、新工作、写入、递归和外部检索；只能使用直接只读工具整理部分结果。`,
    );
  }

  return allowPreTool(contexts);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasValidFinalReport(message, state) {
  if (!state?.briefVerified || !state.taskId || !state.expectedGoal) {
    return false;
  }
  const text = String(message || '').trim();
  const firstLine = text.split(/\r?\n/u, 1)[0].trim();
  if (!new RegExp(`^CONTEXT_OK\\s+${escapeRegExp(state.taskId)}(?:\\s|[:：]|$)`, 'u').test(firstLine)) {
    return false;
  }
  const goalMatch = text.match(/^\s*目标复述\s*[:：]\s*(.+?)\s*$/mu);
  if (!goalMatch || goalMatch[1].trim() !== state.expectedGoal) {
    return false;
  }
  return REQUIRED_FINAL_SECTIONS.every(([, pattern]) => pattern.test(text));
}

function assertSafeGuardPath(guardRoot, target) {
  const root = path.resolve(guardRoot);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`拒绝清理 agent-guard 根目录之外的路径：${resolved}`);
  }
}

async function removeGuardState(guardRoot, key, state) {
  const targets = [
    stateFile(guardRoot, key),
    callsDir(guardRoot, key),
    checkpointsDir(guardRoot, key),
  ];
  for (const target of targets) {
    assertSafeGuardPath(guardRoot, target);
    await rm(target, { recursive: true, force: true });
  }
  if (state?.taskId && state.briefVerified) {
    const reservation = reservationFile(guardRoot, state.taskId);
    assertSafeGuardPath(guardRoot, reservation);
    await rm(reservation, { force: true });
  }
}

export async function handleSubagentStop(event, options = {}) {
  const guardRoot = options.guardRoot || process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT;
  const agentId = String(event.agent_id || '').trim();
  if (!agentId) {
    return { exitCode: 0, output: null };
  }

  const key = getStateKey(event);
  const state = await readJson(stateFile(guardRoot, key));
  const valid = hasValidFinalReport(event.last_assistant_message, state);
  if (!valid && !event.stop_hook_active) {
    return {
      exitCode: 0,
      output: {
        decision: 'block',
        reason: FINAL_FORMAT_REASON,
      },
    };
  }

  await removeGuardState(guardRoot, key, state);
  if (!valid) {
    return {
      exitCode: 0,
      output: {
        systemMessage: 'agent-guard: 收口重试后仍缺少四项状态，已结束该 Agent，不再继续追问。',
      },
    };
  }

  return { exitCode: 0, output: null };
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    throw new Error('hook 未从 stdin 收到 JSON');
  }
  return JSON.parse(text);
}

function printHookResult(result) {
  if (result.output) {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  }
  process.exitCode = result.exitCode || 0;
}

function hookFallback(hookName, eventName) {
  if (
    hookName === 'pre-tool-use'
    || eventName === 'PreToolUse'
    || eventName === 'preToolUse'
    || eventName === 'pre-tool-use'
  ) {
    printHookResult(denyPreTool(
      'agent-guard 执行异常，无法验证预算状态。为防失控，本次子 Agent 工具调用已拒绝；请立即收口。',
    ));
    return;
  }

  printHookResult({
    exitCode: 0,
    output: {
      systemMessage: `agent-guard: ${hookName || eventName} 执行异常，已记录到 stderr。`,
    },
  });
}

async function commandHook(hookName) {
  let event;
  try {
    event = await readStdinJson();
    if (hookName === 'subagent-start') {
      return printHookResult(await handleSubagentStart(event));
    }
    if (hookName === 'pre-tool-use') {
      return printHookResult(await handlePreToolUse(event));
    }
    if (hookName === 'subagent-stop') {
      return printHookResult(await handleSubagentStop(event));
    }
    throw new Error(`未知 hook：${hookName}`);
  } catch (error) {
    process.stderr.write(`agent-guard ${hookName} failed: ${error?.stack || error}\n`);
    return hookFallback(hookName, event?.hook_event_name);
  }
}

async function validateBriefCommand(file) {
  if (!file) {
    throw new Error('用法：npm run agent:brief -- run/agent-briefs/<TASK_ID>.md');
  }
  const text = await readFile(file, 'utf8');
  const result = validateBriefText(text, { filename: file });
  if (result.ok) {
    result.reservation = await createBriefReservation({
      briefPath: file,
      validation: result,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function stageForState(state, callCount, now) {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(state.startedAt));
  const timeRatio = elapsedMs / (state.wallClockMinutes * 60_000);
  const callRatio = callCount / state.toolCallBudget;
  const progress = Math.max(timeRatio, callRatio);
  if (now.getTime() >= Date.parse(state.hardDeadline)) {
    return { stage: 'deadline', progress };
  }
  if (progress >= 0.8) {
    return { stage: 'closeout', progress };
  }
  if (progress >= 0.7) {
    return { stage: 'checkpoint-2', progress };
  }
  if (progress >= 0.4) {
    return { stage: 'checkpoint-1', progress };
  }
  return { stage: 'working', progress };
}

export async function listGuardStatus(options = {}) {
  const guardRoot = options.guardRoot || process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT;
  const now = options.now || new Date();
  const statesRoot = path.join(guardRoot, 'states');
  let entries = [];
  try {
    entries = await readdir(statesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const state = await readJson(path.join(statesRoot, entry.name));
    if (!state) {
      continue;
    }
    const key = path.basename(entry.name, '.json');
    const callCount = await countJsonFiles(callsDir(guardRoot, key));
    const { stage, progress } = stageForState(state, callCount, now);
    records.push({
      agentId: state.agentId,
      agentType: state.agentType,
      taskId: state.taskId || null,
      briefVerified: Boolean(state.briefVerified),
      startedAt: state.startedAt,
      hardDeadline: state.hardDeadline,
      wallClockMinutes: state.wallClockMinutes,
      toolCalls: callCount,
      toolCallBudget: state.toolCallBudget,
      progressPct: Math.round(progress * 100),
      stage,
      overdue: now.getTime() >= Date.parse(state.hardDeadline),
    });
  }

  records.sort((a, b) => a.hardDeadline.localeCompare(b.hardDeadline));
  return records;
}

export async function cleanupOrphanedGuardData(options = {}) {
  const guardRoot = options.guardRoot || process.env.AGENT_GUARD_ROOT || DEFAULT_GUARD_ROOT;
  const now = options.now || new Date();
  const statesRoot = path.join(guardRoot, 'states');
  const staleStateGraceMs = 5 * 60_000;
  let stateEntries = [];
  try {
    stateEntries = await readdir(statesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  const result = {
    staleStates: 0,
    orphanCallDirs: 0,
    orphanCheckpointDirs: 0,
    expiredReservations: 0,
  };
  const activeKeys = new Set();
  for (const entry of stateEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const key = path.basename(entry.name, '.json');
    const state = await readJson(path.join(statesRoot, entry.name));
    if (
      state
      && Date.parse(state.hardDeadline) + staleStateGraceMs <= now.getTime()
    ) {
      await removeGuardState(guardRoot, key, state);
      result.staleStates += 1;
    } else {
      activeKeys.add(key);
    }
  }
  for (const [name, countKey] of [
    ['calls', 'orphanCallDirs'],
    ['checkpoints', 'orphanCheckpointDirs'],
  ]) {
    const directory = path.join(guardRoot, name);
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || activeKeys.has(entry.name)) {
        continue;
      }
      const target = path.join(directory, entry.name);
      assertSafeGuardPath(guardRoot, target);
      await rm(target, { recursive: true, force: true });
      result[countKey] += 1;
    }
  }

  const reservations = reservationsDir(guardRoot);
  let reservationEntries = [];
  try {
    reservationEntries = await readdir(reservations, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  for (const entry of reservationEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const file = path.join(reservations, entry.name);
    const reservation = await readJson(file);
    if (
      reservation
      && !reservation.claimedBy
      && Date.parse(reservation.expiresAt) <= now.getTime()
    ) {
      assertSafeGuardPath(guardRoot, file);
      await rm(file, { force: true });
      result.expiredReservations += 1;
    }
  }

  return result;
}

async function statusCommand(values) {
  const records = await listGuardStatus();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
  } else if (records.length === 0) {
    process.stdout.write('No active guarded subagents.\n');
  } else {
    const lines = records.map((record) => [
      `${record.taskId || 'UNVERIFIED'}/${record.agentType}/${record.agentId}`,
      record.briefVerified ? 'brief verified' : 'brief MISSING',
      `tools ${record.toolCalls}/${record.toolCallBudget}`,
      `${record.progressPct}%`,
      record.stage,
      `deadline ${record.hardDeadline}`,
    ].join(' | '));
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (values.failOverdue && records.some((record) => record.overdue)) {
    process.exitCode = 2;
  }
  if (values.requireTask) {
    const required = records.find((record) => record.taskId === values.requireTask);
    if (!required) {
      process.stderr.write(`agent-guard: 未找到运行中的 TASK_ID ${values.requireTask}\n`);
      process.exitCode = 3;
    } else if (!required.briefVerified) {
      process.stderr.write(`agent-guard: TASK_ID ${values.requireTask} 未绑定已校验简报\n`);
      process.exitCode = 4;
    }
  }
}

async function initBriefCommand(values) {
  if (!values.taskId || !values.agentType) {
    throw new Error(
      '用法：npm run agent:brief:init -- --task-id DOMAIN-TOPIC-YYYYMMDD-01 --agent-type workspace_explorer --objective "..."',
    );
  }
  const template = buildBriefTemplate({
    taskId: values.taskId,
    agentType: values.agentType,
    objective: values.objective || '填写本次单一边界任务目标',
  });
  if (!values.path) {
    process.stdout.write(template);
    return;
  }

  const fullPath = path.resolve(values.path);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, template, { encoding: 'utf8', flag: 'wx' });
  const validation = validateBriefText(template, { filename: fullPath });
  process.stdout.write(`${JSON.stringify({ path: fullPath, ...validation }, null, 2)}\n`);
  if (!validation.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    process.stdout.write(
      'Commands: hook <subagent-start|pre-tool-use|subagent-stop>, validate-brief <file>, cancel-reservation <TASK_ID>, cleanup, status [--json] [--fail-overdue] [--require-task id], init-brief --task-id ... --agent-type ...\n',
    );
    return;
  }

  if (command === 'hook') {
    return commandHook(rest[0]);
  }
  if (command === 'validate-brief') {
    return validateBriefCommand(rest[0]);
  }
  if (command === 'cancel-reservation') {
    const canceled = await cancelBriefReservation({ taskId: rest[0] });
    process.stdout.write(`${JSON.stringify({ taskId: rest[0], canceled }, null, 2)}\n`);
    return;
  }
  if (command === 'cleanup') {
    const result = await cleanupOrphanedGuardData();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: 'boolean', default: false },
      'fail-overdue': { type: 'boolean', default: false },
      'require-task': { type: 'string' },
      'task-id': { type: 'string' },
      'agent-type': { type: 'string' },
      objective: { type: 'string' },
      path: { type: 'string' },
    },
    strict: true,
  });

  if (command === 'status') {
    return statusCommand({
      json: values.json,
      failOverdue: values['fail-overdue'],
      requireTask: values['require-task'],
    });
  }
  if (command === 'init-brief') {
    return initBriefCommand({
      taskId: values['task-id'],
      agentType: values['agent-type'],
      objective: values.objective,
      path: values.path,
    });
  }

  throw new Error(`未知命令：${command}`);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`agent-guard failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
