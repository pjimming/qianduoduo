import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildBriefTemplate,
  cancelBriefReservation,
  cleanupOrphanedGuardData,
  createBriefReservation,
  handlePreToolUse,
  handleSubagentStart,
  handleSubagentStop,
  listGuardStatus,
  validateBriefText,
} from '../scripts/agent-guard.mjs';

const START = new Date('2026-10-25T08:00:00.000Z');
const DEFAULT_TASK_ID = 'GUARD-TEST-20261025-01';
const DEFAULT_GOAL = '验证运行防护';

async function withGuardRoot(run) {
  const guardRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-guard-test-'));
  try {
    await run(guardRoot);
  } finally {
    await rm(guardRoot, { recursive: true, force: true });
  }
}

function baseEvent(overrides = {}) {
  return {
    session_id: 'session-test',
    agent_id: 'agent-test',
    agent_type: 'workspace_explorer',
    hook_event_name: 'PreToolUse',
    model: 'test-model',
    tool_name: 'read_file',
    tool_input: {},
    tool_use_id: 'tool-1',
    ...overrides,
  };
}

async function reserve(guardRoot, options = {}) {
  const taskId = options.taskId || DEFAULT_TASK_ID;
  const agentType = options.agentType || 'workspace_explorer';
  const goal = options.goal || DEFAULT_GOAL;
  const text = buildBriefTemplate({
    taskId,
    agentType,
    objective: goal,
    now: options.createdAt || START,
  });
  const validationText = options.deadline
    ? text.replace(/("hard_deadline":\s*")[^"]+"/u, `$1${options.deadline}"`)
    : text;
  const validation = validateBriefText(validationText, {
    filename: `run/agent-briefs/${taskId}.md`,
    now: options.createdAt || START,
  });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  return createBriefReservation({
    guardRoot,
    briefPath: `run/agent-briefs/${taskId}.md`,
    validation,
    now: options.createdAt || START,
  });
}

async function start(guardRoot, now = START, options = {}) {
  const reservation = options.reservation === null
    ? null
    : options.reservation || await reserve(guardRoot, options);
  const eventOverrides = options.agentType ? { agent_type: options.agentType } : {};
  return handleSubagentStart(baseEvent(eventOverrides), {
    guardRoot,
    now,
    reservation,
  });
}

function decision(result) {
  return result.output?.hookSpecificOutput?.permissionDecision || null;
}

test('brief template contains a valid deadline, tool budget, checkpoints, and no recursion', () => {
  const taskId = 'GUARD-TEST-20261025-01';
  const text = buildBriefTemplate({
    taskId,
    agentType: 'workspace_explorer',
    objective: '验证任务简报',
    now: START,
  });
  const result = validateBriefText(text, {
    filename: `${taskId}.md`,
    now: START,
  });

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.metadata.hard_deadline, '2026-10-25T08:10:00.000Z');
  assert.equal(result.metadata.wall_clock_minutes, 10);
  assert.equal(result.metadata.tool_call_budget, 30);
  assert.deepEqual(
    [
      result.metadata.checkpoint_1_pct,
      result.metadata.checkpoint_2_pct,
      result.metadata.closeout_pct,
    ],
    [40, 70, 80],
  );
  assert.equal(result.metadata.recursion_allowed, false);
});

test('brief validation rejects recursion, a mismatched budget, and a past deadline', () => {
  const taskId = 'GUARD-TEST-20261025-02';
  const text = buildBriefTemplate({
    taskId,
    agentType: 'stock_research_analyst',
    objective: '验证失败边界',
    now: START,
  })
    .replace('"tool_call_budget": 120', '"tool_call_budget": 999')
    .replace('"recursion_allowed": false', '"recursion_allowed": true')
    .replace('"hard_deadline": "2026-10-25T08:45:00.000Z"', '"hard_deadline": "2026-10-25T07:00:00.000Z"');

  const result = validateBriefText(text, {
    filename: `${taskId}.md`,
    now: START,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /tool_call_budget 必须为 120/u);
  assert.match(result.errors.join('\n'), /recursion_allowed 必须为 false/u);
  assert.match(result.errors.join('\n'), /hard_deadline 必须晚于当前时间/u);
});

test('subagent start registers a deadline and hook instructions', async () => {
  await withGuardRoot(async (guardRoot) => {
    const result = await start(guardRoot);
    assert.equal(result.exitCode, 0);
    assert.match(
      result.output.hookSpecificOutput.additionalContext,
      /墙钟上限 10 分钟/u,
    );
    assert.match(
      result.output.hookSpecificOutput.additionalContext,
      /禁止调用 spawn_agent/u,
    );

    const statuses = await listGuardStatus({ guardRoot, now: START });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].agentType, 'workspace_explorer');
    assert.equal(statuses[0].taskId, DEFAULT_TASK_ID);
    assert.equal(statuses[0].briefVerified, true);
    assert.equal(statuses[0].toolCalls, 0);
    assert.equal(statuses[0].stage, 'working');
  });
});

test('SubagentStart consumes the validated brief reservation and binds its TASK_ID', async () => {
  await withGuardRoot(async (guardRoot) => {
    const reservation = await reserve(guardRoot);
    assert.equal(reservation.taskId, DEFAULT_TASK_ID);
    assert.equal(reservation.claimedBy, null);

    await handleSubagentStart(baseEvent(), {
      guardRoot,
      now: new Date(START.getTime() + 30_000),
    });
    const statuses = await listGuardStatus({
      guardRoot,
      now: new Date(START.getTime() + 30_000),
    });

    assert.equal(statuses[0].taskId, DEFAULT_TASK_ID);
    assert.equal(statuses[0].briefVerified, true);
    const reservationAfterClaim = JSON.parse(
      await readFile(path.join(guardRoot, 'reservations', `${DEFAULT_TASK_ID}.json`), 'utf8'),
    );
    assert.equal(reservationAfterClaim.claimedBy, 'agent-test');
  });
});

test('only one pending reservation per agent type is allowed and it can be cancelled', async () => {
  await withGuardRoot(async (guardRoot) => {
    await reserve(guardRoot);
    await assert.rejects(
      reserve(guardRoot, {
        taskId: 'GUARD-TEST-20261025-04',
        goal: '第二个待派发任务',
      }),
      /已有待派发 reservation/u,
    );

    assert.equal(
      await cancelBriefReservation({ guardRoot, taskId: DEFAULT_TASK_ID }),
      true,
    );
    const next = await reserve(guardRoot, {
      taskId: 'GUARD-TEST-20261025-04',
      goal: '第二个待派发任务',
    });
    assert.equal(next.taskId, 'GUARD-TEST-20261025-04');
  });
});

test('cleanup removes orphaned call/checkpoint directories and expired reservations', async () => {
  await withGuardRoot(async (guardRoot) => {
    await reserve(guardRoot);
    await mkdir(path.join(guardRoot, 'calls', 'orphan-calls'), { recursive: true });
    await mkdir(path.join(guardRoot, 'checkpoints', 'orphan-checkpoints'), { recursive: true });
    await writeFile(path.join(guardRoot, 'calls', 'orphan-calls', 'one.json'), '{}\n', 'utf8');
    await writeFile(path.join(guardRoot, 'checkpoints', 'orphan-checkpoints', '40.json'), '{}\n', 'utf8');

    const result = await cleanupOrphanedGuardData({
      guardRoot,
      now: new Date(START.getTime() + 3 * 60_000),
    });

    assert.deepEqual(result, {
      staleStates: 0,
      orphanCallDirs: 1,
      orphanCheckpointDirs: 1,
      expiredReservations: 1,
    });
    await assert.rejects(access(path.join(guardRoot, 'calls', 'orphan-calls')));
    await assert.rejects(access(path.join(guardRoot, 'checkpoints', 'orphan-checkpoints')));
    await assert.rejects(access(path.join(guardRoot, 'reservations', `${DEFAULT_TASK_ID}.json`)));
  });
});

test('cleanup removes states that passed their deadline and grace window', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot, START, {
      deadline: '2026-10-25T08:02:00.000Z',
    });
    const result = await cleanupOrphanedGuardData({
      guardRoot,
      now: new Date('2026-10-25T08:08:00.000Z'),
    });

    assert.equal(result.staleStates, 1);
    const statuses = await listGuardStatus({
      guardRoot,
      now: new Date('2026-10-25T08:08:00.000Z'),
    });
    assert.deepEqual(statuses, []);
  });
});

test('nested subagent creation is denied at runtime', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);
    const result = await handlePreToolUse(
      baseEvent({ tool_name: 'spawn_agent', tool_use_id: 'spawn-1' }),
      { guardRoot, now: new Date('2026-10-25T08:01:00.000Z') },
    );

    assert.equal(decision(result), 'deny');
    assert.match(
      result.output.hookSpecificOutput.permissionDecisionReason,
      /主 Agent 使用新 TASK_ID/u,
    );
  });
});

test('40%, 70%, and 80% checkpoints become visible and closeout blocks new writes', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);

    let checkpointOne = null;
    for (let index = 1; index <= 12; index += 1) {
      const result = await handlePreToolUse(
        baseEvent({ tool_use_id: `read-${index}` }),
        {
          guardRoot,
          now: new Date(START.getTime() + 60_000),
        },
      );
      assert.equal(result.exitCode, 0);
      if (result.output?.systemMessage) {
        checkpointOne = result.output.systemMessage;
      }
    }
    assert.match(checkpointOne || '', /检查点 1（40%）/u);

    let checkpointTwo = null;
    for (let index = 13; index <= 21; index += 1) {
      const result = await handlePreToolUse(
        baseEvent({ tool_use_id: `read-${index}` }),
        {
          guardRoot,
          now: new Date(START.getTime() + 60_000),
        },
      );
      assert.equal(result.exitCode, 0);
      if (result.output?.systemMessage) {
        checkpointTwo = result.output.systemMessage;
      }
    }
    assert.match(checkpointTwo || '', /检查点 2（70%）/u);

    for (let index = 22; index <= 24; index += 1) {
      const result = await handlePreToolUse(
        baseEvent({ tool_use_id: `read-${index}` }),
        {
          guardRoot,
          now: new Date(START.getTime() + 60_000),
        },
      );
      assert.equal(decision(result), null);
      if (index === 24) {
        assert.match(result.output.systemMessage, /80% 收口闸门/u);
      }
    }

    const closeoutWrite = await handlePreToolUse(
      baseEvent({
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch' },
        tool_use_id: 'write-25',
      }),
      {
        guardRoot,
        now: new Date(START.getTime() + 60_000),
      },
    );
    assert.equal(decision(closeoutWrite), 'deny');
    assert.match(
      closeoutWrite.output.hookSpecificOutput.permissionDecisionReason,
      /禁止 shell、新工作、写入、递归和外部检索/u,
    );

    const shellBypass = await handlePreToolUse(
      baseEvent({
        tool_name: 'Bash',
        tool_input: {
          command: "Get-Content README.md | ForEach-Object { [IO.File]::WriteAllText('run/bypass.txt', $_) }",
        },
        tool_use_id: 'shell-26',
      }),
      {
        guardRoot,
        now: new Date(START.getTime() + 60_000),
      },
    );
    assert.equal(decision(shellBypass), 'deny');
  });
});

test('an unverified or expired brief reservation freezes all tools', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot, START, { reservation: null });
    const result = await handlePreToolUse(
      baseEvent({ tool_use_id: 'unverified-read' }),
      { guardRoot, now: new Date('2026-10-25T08:00:01.000Z') },
    );

    assert.equal(decision(result), 'deny');
    assert.match(
      result.output.hookSpecificOutput.permissionDecisionReason,
      /未找到有效期内且已校验的任务简报/u,
    );
  });
});

test('the absolute brief deadline overrides the longer role budget', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot, START, {
      deadline: '2026-10-25T08:02:00.000Z',
    });
    const statuses = await listGuardStatus({ guardRoot, now: START });
    assert.equal(statuses[0].hardDeadline, '2026-10-25T08:02:00.000Z');

    const afterDeadline = await handlePreToolUse(
      baseEvent({ tool_use_id: 'short-deadline-read' }),
      { guardRoot, now: new Date('2026-10-25T08:02:01.000Z') },
    );
    assert.equal(decision(afterDeadline), 'deny');
    assert.match(
      afterDeadline.output.hookSpecificOutput.permissionDecisionReason,
      /已到硬截止/u,
    );
  });
});

test('the tool budget and wall clock deadline freeze all remaining tools', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);
    for (let index = 1; index <= 30; index += 1) {
      await handlePreToolUse(
        baseEvent({ tool_use_id: `budget-read-${index}` }),
        {
          guardRoot,
          now: new Date(START.getTime() + 1_000),
        },
      );
    }

    const exhausted = await handlePreToolUse(
      baseEvent({ tool_use_id: 'budget-read-31' }),
      {
        guardRoot,
        now: new Date(START.getTime() + 2_000),
      },
    );
    assert.equal(decision(exhausted), 'deny');
    assert.match(
      exhausted.output.hookSpecificOutput.permissionDecisionReason,
      /预算 30 次已用尽/u,
    );

    const deadline = await handlePreToolUse(
      baseEvent({ tool_use_id: 'deadline-read' }),
      {
        guardRoot,
        now: new Date('2026-10-25T08:10:01.000Z'),
      },
    );
    assert.equal(decision(deadline), 'deny');
    assert.match(
      deadline.output.hookSpecificOutput.permissionDecisionReason,
      /已到硬截止/u,
    );
  });
});

test('subagent stop requests one closeout retry and then removes guard state', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);

    const invalid = await handleSubagentStop(
      baseEvent({
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        last_assistant_message: 'CONTEXT_OK GUARD-TEST: 做完了。',
      }),
      { guardRoot },
    );
    assert.equal(invalid.output.decision, 'block');
    assert.match(invalid.output.reason, /准确 TASK_ID/u);
    assert.match(invalid.output.reason, /目标复述/u);
    assert.match(invalid.output.reason, /已完成：、未完成：、可恢复状态：、剩余风险：/u);

    const invalidAfterRetry = await handleSubagentStop(
      baseEvent({
        hook_event_name: 'SubagentStop',
        stop_hook_active: true,
        last_assistant_message: 'CONTEXT_OK GUARD-TEST: 仍未按格式返回。',
      }),
      { guardRoot },
    );
    assert.match(invalidAfterRetry.output.systemMessage, /不再继续追问/u);

    const states = await readdir(path.join(guardRoot, 'states')).catch(() => []);
    assert.deepEqual(states, []);
  });
});

test('a compliant final response passes and cleans runtime state', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);
    const result = await handleSubagentStop(
      baseEvent({
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        last_assistant_message: [
          `CONTEXT_OK ${DEFAULT_TASK_ID}`,
          `目标复述：${DEFAULT_GOAL}`,
          '已完成：预算与截止检查通过。',
          '未完成：无。',
          '可恢复状态：无运行中工具。',
          '剩余风险：仍依赖主 Agent 到点中断。',
        ].join('\n'),
      }),
      { guardRoot },
    );

    assert.equal(result.output, null);
    const states = await readdir(path.join(guardRoot, 'states')).catch(() => []);
    assert.deepEqual(states, []);
  });
});

test('wrong TASK_ID or paraphrased goal cannot pass SubagentStop', async () => {
  await withGuardRoot(async (guardRoot) => {
    await start(guardRoot);
    const result = await handleSubagentStop(
      baseEvent({
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        last_assistant_message: [
          'CONTEXT_OK WRONG-TASK-ID',
          '目标复述：我自己改写的目标',
          '已完成：无。',
          '未完成：身份校验失败。',
          '可恢复状态：保留运行状态。',
          '剩余风险：错误任务可能被误认。',
        ].join('\n'),
      }),
      { guardRoot },
    );

    assert.equal(result.output.decision, 'block');
    const states = await readdir(path.join(guardRoot, 'states'));
    assert.equal(states.length, 1);
  });
});

test('PreToolUse command hook fails closed on malformed stdin', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/agent-guard.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [scriptPath, 'hook', 'pre-tool-use'],
    {
      input: 'not-json',
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.stderr, /pre-tool-use failed/u);
});
