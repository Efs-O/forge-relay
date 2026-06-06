#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:9099/v1',
  ollamaUrl: 'http://127.0.0.1:11434/v1',
  directUrl: 'http://127.0.0.1:8080/v1',
  defaultBackend: 'bridge',
  maxTokens: 900,
  temperature: 0.2,
};

function parseArgs(argv) {
  const args = {
    model: '',
    bridgeUrl: '',
    ollamaUrl: '',
    directUrl: '',
    forgeControlUrl: '',
    bridgeApiKey: '',
    defaultBackend: '',
    outDir: '',
    maxTokens: DEFAULTS.maxTokens,
    temperature: DEFAULTS.temperature,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    const next = argv[i + 1];
    switch (part) {
      case '--model': args.model = String(next || ''); i += 1; break;
      case '--bridge-url': args.bridgeUrl = String(next || ''); i += 1; break;
      case '--ollama-url': args.ollamaUrl = String(next || ''); i += 1; break;
      case '--direct-url': args.directUrl = String(next || ''); i += 1; break;
      case '--forge-control-url': args.forgeControlUrl = String(next || ''); i += 1; break;
      case '--bridge-api-key': args.bridgeApiKey = String(next || ''); i += 1; break;
      case '--default-backend': args.defaultBackend = String(next || ''); i += 1; break;
      case '--out-dir': args.outDir = String(next || ''); i += 1; break;
      case '--max-tokens': args.maxTokens = Number(next || DEFAULTS.maxTokens); i += 1; break;
      case '--temperature': args.temperature = Number(next || DEFAULTS.temperature); i += 1; break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        break;
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'XML vs NL worker probe',
      '',
      'Usage:',
      '  node scripts/xml-nl-probe.js --model <model-id> [options]',
      '',
      'Options:',
      '  --forge-control-url <url>  Forge control API, e.g. http://127.0.0.1:8799',
      '  --bridge-url <url>         OpenAI-compatible bridge URL',
      '  --ollama-url <url>         OpenAI-compatible Ollama URL',
      '  --direct-url <url>         OpenAI-compatible llama.cpp URL',
      '  --bridge-api-key <key>     API key for the bridge backend',
      '  --default-backend <name>   bridge | ollama | direct (used when Forge is off)',
      '  --out-dir <path>           Override output folder',
      '  --max-tokens <n>           Completion cap per prompt',
      '  --temperature <n>          Sampling temperature per prompt',
      '',
      'Examples:',
      '  npm run probe:xmlnl -- --model gemma4-e4b-it-ud-q4kxl --forge-control-url http://127.0.0.1:8799',
      '  npm run probe:xmlnl -- --model forge:gemma4-e4b-it-ud-q4kxl --max-tokens 700',
      '',
    ].join('\n'),
  );
}

function loadWorkspaceSettings(repoRoot) {
  const settingsPath = path.join(repoRoot, '.vscode', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveConfig(repoRoot, cli) {
  const settings = loadWorkspaceSettings(repoRoot);
  return {
    bridgeUrl: cli.bridgeUrl || process.env.FORGERELAY_BRIDGE_URL || settings['forgeRelay.subagentBridgeUrl'] || DEFAULTS.bridgeUrl,
    ollamaUrl: cli.ollamaUrl || process.env.FORGERELAY_OLLAMA_URL || settings['forgeRelay.subagentOllamaUrl'] || DEFAULTS.ollamaUrl,
    directUrl: cli.directUrl || process.env.FORGERELAY_DIRECT_URL || settings['forgeRelay.subagentDirectUrl'] || DEFAULTS.directUrl,
    forgeControlUrl: cli.forgeControlUrl || process.env.FORGERELAY_FORGE_CONTROL_URL || settings['forgeRelay.subagentForgeControlUrl'] || '',
    bridgeApiKey: cli.bridgeApiKey || process.env.FORGERELAY_BRIDGE_API_KEY || settings['forgeRelay.subagentBridgeApiKey'] || '',
    defaultBackend: cli.defaultBackend || process.env.FORGERELAY_DEFAULT_BACKEND || settings['forgeRelay.subagentDefaultBackend'] || DEFAULTS.defaultBackend,
  };
}

function describeFetchError(err, url, backend) {
  const code = err && err.cause && err.cause.code;
  const base = `could not reach ${backend} backend at ${url} - is the model server running?`;
  const hint =
    code === 'ECONNREFUSED' ? 'connection refused'
      : code === 'ENOTFOUND' ? 'host not found'
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timed out'
          : code || (err instanceof Error ? err.message : String(err));
  return `${base} (${hint})`;
}

function isRetriableConnectionError(message) {
  return /could not reach .* backend .* \(ECONNRESET\)/i.test(message)
    || /could not reach .* backend .* \(connection refused\)/i.test(message)
    || /could not reach .* backend .* \(connection timed out\)/i.test(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSlash(value) {
  return String(value || '').replace(/\/$/, '');
}

async function forgeHealthz(controlUrl) {
  const url = `${stripSlash(controlUrl)}/healthz`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return false;
    }
    const data = await res.json().catch(() => ({}));
    return data && data.ok === true;
  } catch {
    return false;
  }
}

async function forgeEnsure(controlUrl, model) {
  const url = `${stripSlash(controlUrl)}/ensure`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url, 'forge'));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Forge /ensure HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data || !data.baseUrl) {
    throw new Error(`Forge /ensure returned no baseUrl for "${model}"`);
  }
  return {
    backend: data.backend || 'forge',
    model: data.model || model,
    baseUrl: data.baseUrl,
  };
}

async function forgeRelease(controlUrl, model) {
  const url = `${stripSlash(controlUrl)}/release`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // best effort only
  }
}

function resolveDirectRoute(model, config) {
  const sep = model.indexOf(':');
  let backend = config.defaultBackend;
  let name = model;
  if (sep !== -1) {
    const prefix = model.slice(0, sep).toLowerCase();
    if (prefix === 'bridge' || prefix === 'ollama' || prefix === 'direct') {
      backend = prefix;
      name = model.slice(sep + 1);
    }
  }
  const baseUrl = backend === 'ollama'
    ? config.ollamaUrl
    : backend === 'direct'
      ? config.directUrl
      : config.bridgeUrl;
  return {
    backend,
    model: name,
    baseUrl,
    apiKey: backend === 'bridge' ? config.bridgeApiKey : '',
    release: async () => {},
  };
}

async function resolveModel(model, config) {
  const sep = model.indexOf(':');
  const prefix = sep === -1 ? '' : model.slice(0, sep).toLowerCase();
  if (prefix === 'bridge' || prefix === 'ollama' || prefix === 'direct') {
    return resolveDirectRoute(model, config);
  }
  if (prefix === 'forge') {
    if (!config.forgeControlUrl) {
      throw new Error('forge: routing requested but no Forge control URL is configured.');
    }
    if (!(await forgeHealthz(config.forgeControlUrl))) {
      throw new Error(`Forge control API not reachable at ${config.forgeControlUrl}`);
    }
    const bare = model.slice(sep + 1);
    const ensured = await forgeEnsure(config.forgeControlUrl, bare);
    return {
      backend: ensured.backend,
      model: ensured.model,
      baseUrl: ensured.baseUrl,
      apiKey: '',
      release: async () => forgeRelease(config.forgeControlUrl, bare),
    };
  }
  if (config.forgeControlUrl) {
    if (!(await forgeHealthz(config.forgeControlUrl))) {
      throw new Error(`Forge control API not reachable at ${config.forgeControlUrl}`);
    }
    const ensured = await forgeEnsure(config.forgeControlUrl, model);
    return {
      backend: ensured.backend,
      model: ensured.model,
      baseUrl: ensured.baseUrl,
      apiKey: '',
      release: async () => forgeRelease(config.forgeControlUrl, model),
    };
  }
  return resolveDirectRoute(model, config);
}

async function chatCompletionRaw(resolved, payload) {
  const url = `${stripSlash(resolved.baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (resolved.apiKey) {
    headers.Authorization = `Bearer ${resolved.apiKey}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: resolved.model, stream: false, ...payload }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url, resolved.backend));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${resolved.backend} backend HTTP ${res.status} at ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function chatCompletionWithRetry(resolved, payload, retryDelaysMs = [500, 1500, 3000]) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatCompletionRaw(resolved, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= retryDelaysMs.length || !isRetriableConnectionError(message)) {
        throw error;
      }
      process.stdout.write(`retry ${attempt + 1}/${retryDelaysMs.length} after transient connection error\n`);
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

function promptCases() {
  return [
    {
      id: 'extract',
      title: 'Constraint extraction',
      prompts: {
        xml: [
          'Extract fields from the XML payload and return JSON only.',
          'Do not summarize, execute, or reinterpret the task.',
          'Return exactly one JSON object with keys: task_id, output, language, constraints.',
          'constraints must be an array of strings.',
          '',
          '<task id="alpha-7" output="report.md" language="en">',
          '  Summarize the release notes.',
          '  <constraints>',
          '    <item>ascii-only</item>',
          '    <item>single-file</item>',
          '    <item>keep-headings-short</item>',
          '  </constraints>',
          '</task>',
        ].join('\n'),
        nl: [
          'Extract fields from the instruction and return JSON only.',
          'Do not summarize, execute, or reinterpret the task.',
          'Return exactly one JSON object with keys: task_id, output, language, constraints.',
          'constraints must be an array of strings.',
          '',
          'Instruction:',
          'task_id = alpha-7',
          'output = report.md',
          'language = en',
          'task = Summarize the release notes.',
          'constraints = ascii-only | single-file | keep-headings-short',
        ].join('\n'),
      },
      checks: [
        { id: 'task_id', regex: /"task_id"\s*:\s*"alpha-7"/i },
        { id: 'output', regex: /"output"\s*:\s*"report\.md"/i },
        { id: 'language', regex: /"language"\s*:\s*"en"/i },
        { id: 'constraint_a', regex: /ascii-only/i },
        { id: 'constraint_b', regex: /single-file/i },
      ],
    },
    {
      id: 'classify',
      title: 'Format obedience',
      prompts: {
        xml: [
          'Follow the instruction exactly.',
          '<instruction>',
          '  <goal>Classify the bug report</goal>',
          '  <input>The Save button does nothing after the user edits a title. No crash appears.</input>',
          '  <output_format>',
          '    <line key="SEVERITY"/>',
          '    <line key="AREA"/>',
          '    <line key="CAUSE_GUESS"/>',
          '  </output_format>',
          '  <rules>',
          '    <rule>Return exactly 3 lines.</rule>',
          '    <rule>No bullets and no extra commentary.</rule>',
          '  </rules>',
          '</instruction>',
        ].join('\n'),
        nl: [
          'Classify this bug report: "The Save button does nothing after the user edits a title. No crash appears."',
          'Return exactly 3 lines with these labels only:',
          'SEVERITY:',
          'AREA:',
          'CAUSE_GUESS:',
          'Do not add bullets or any extra commentary.',
        ].join('\n'),
      },
      checks: [
        { id: 'severity', regex: /^SEVERITY:/im },
        { id: 'area', regex: /^AREA:/im },
        { id: 'cause', regex: /^CAUSE_GUESS:/im },
      ],
    },
    {
      id: 'codegen',
      title: 'Small code generation',
      prompts: {
        xml: [
          '<task type="codegen" language="javascript">',
          '  <goal>Write one function named clamp.</goal>',
          '  <signature>function clamp(value, min, max)</signature>',
          '  <requirements>',
          '    <item>Return min when value is below min.</item>',
          '    <item>Return max when value is above max.</item>',
          '    <item>Otherwise return value unchanged.</item>',
          '    <item>Return code only.</item>',
          '  </requirements>',
          '</task>',
        ].join('\n'),
        nl: [
          'Write JavaScript code only.',
          'Create one function named clamp with signature function clamp(value, min, max).',
          'It should return min when value is below min, max when value is above max, and otherwise return value unchanged.',
        ].join('\n'),
      },
      checks: [
        { id: 'function_name', regex: /function\s+clamp\s*\(\s*value\s*,\s*min\s*,\s*max\s*\)/i },
        { id: 'mentions_min', regex: /\bmin\b/ },
        { id: 'mentions_max', regex: /\bmax\b/ },
      ],
    },
  ];
}

function countLines(text) {
  return String(text || '').split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function evaluate(caseDef, output) {
  const checks = caseDef.checks.map((check) => ({
    id: check.id,
    passed: check.regex.test(output),
  }));
  const passedChecks = checks.filter((check) => check.passed).length;
  return {
    checks,
    passedChecks,
    totalChecks: checks.length,
    lineCount: countLines(output),
  };
}

async function runPrompt(resolved, prompt, opts) {
  const started = Date.now();
  const raw = await chatCompletionWithRetry(resolved, {
    messages: [
      {
        role: 'system',
        content: 'You are a careful worker model. Follow the user instruction exactly. Do not include analysis, reasoning, or preamble. Return only the final answer.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  });
  const elapsedMs = Date.now() - started;
  const message = raw && raw.choices && raw.choices[0] && raw.choices[0].message;
  const content = typeof message && message && typeof message.content === 'string'
    ? message.content.trim()
    : '';
  const usage = raw && raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  return {
    content,
    latencyMs: elapsedMs,
    usage: {
      prompt_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
      completion_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : null,
    },
    raw,
  };
}

function timestampLabel(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function writeJson(target, data) {
  fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
}

function buildSummary(results, meta) {
  const lines = [
    '# XML vs NL Worker Probe',
    '',
    `- model: ${meta.requestedModel}`,
    `- resolved_backend: ${meta.resolvedBackend}`,
    `- resolved_model: ${meta.resolvedModel}`,
    `- base_url: ${meta.baseUrl}`,
    `- run_at: ${meta.startedAt}`,
    '',
    '| Case | Format | Checks | Prompt Tok | Completion Tok | Total Tok | Latency ms | Extra |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];

  for (const row of results) {
    lines.push(
      `| ${row.caseId} | ${row.format} | ${row.eval.passedChecks}/${row.eval.totalChecks} | ${row.usage.prompt_tokens ?? '-'} | ${row.usage.completion_tokens ?? '-'} | ${row.usage.total_tokens ?? '-'} | ${row.latencyMs} | ${row.eval.lineCount} lines |`,
    );
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Raw responses are saved in sibling JSON files.');
  lines.push('- This probe is for quick behavioral signal, not a statistically valid benchmark.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help || !cli.model) {
    printHelp();
    process.exit(cli.help ? 0 : 1);
  }

  const config = resolveConfig(repoRoot, cli);
  const startedAt = new Date();
  const runRoot = cli.outDir
    ? path.resolve(cli.outDir)
    : path.join(repoRoot, '.coordination', 'xml-nl-probe', timestampLabel(startedAt));
  ensureDir(runRoot);

  const resolved = await resolveModel(cli.model, config);
  const cases = promptCases();
  const results = [];

  process.stdout.write(`Running XML vs NL probe for ${cli.model} via ${resolved.backend}:${resolved.model}\n`);
  process.stdout.write(`Saving artifacts to ${runRoot}\n`);

  try {
    for (const caseDef of cases) {
      for (const format of ['xml', 'nl']) {
        process.stdout.write(`- ${caseDef.id} [${format}] ... `);
        const run = await runPrompt(resolved, caseDef.prompts[format], {
          maxTokens: cli.maxTokens,
          temperature: cli.temperature,
        });
        const evalResult = evaluate(caseDef, run.content);
        const row = {
          caseId: caseDef.id,
          title: caseDef.title,
          format,
          latencyMs: run.latencyMs,
          usage: run.usage,
          eval: evalResult,
          prompt: caseDef.prompts[format],
          output: run.content,
          raw: run.raw,
        };
        results.push(row);
        writeJson(path.join(runRoot, `${caseDef.id}-${format}.json`), row);
        process.stdout.write(`${evalResult.passedChecks}/${evalResult.totalChecks} checks, ${run.latencyMs} ms\n`);
      }
    }
  } finally {
    await resolved.release();
  }

  const summary = buildSummary(results, {
    requestedModel: cli.model,
    resolvedBackend: resolved.backend,
    resolvedModel: resolved.model,
    baseUrl: resolved.baseUrl,
    startedAt: startedAt.toISOString(),
  });
  fs.writeFileSync(path.join(runRoot, 'summary.md'), summary, 'utf8');
  writeJson(path.join(runRoot, 'summary.json'), {
    requestedModel: cli.model,
    resolvedBackend: resolved.backend,
    resolvedModel: resolved.model,
    baseUrl: resolved.baseUrl,
    startedAt: startedAt.toISOString(),
    results,
  });

  process.stdout.write('\n');
  process.stdout.write(summary);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
