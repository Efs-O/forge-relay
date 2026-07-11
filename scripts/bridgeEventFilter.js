'use strict';

function shouldTrigger(event, agent, mode = 'all') {
    if (!event || typeof event !== 'object') return false;
    if (event.agent && String(event.agent).toLowerCase() === agent.toLowerCase()) return false;
    if (event.type === 'post' && /SESSION_(START|END)/.test(event.message || '')) return false;
    if (event.type === 'command') {
        const target = String((event.meta && event.meta.target_agent) || event.target || '').toLowerCase();
        return target === 'all' || target === agent.toLowerCase();
    }
    if (event.type !== 'post') return false;
    if (mode === 'all') return true;
    const poster = String(event.agent || '').toLowerCase();
    const isOrchestrator = poster === 'claude' || poster === 'codex' || poster === 'forge-coordinator';
    const isWorker = poster.startsWith('worker:') || poster.startsWith('worker-');
    if (!isOrchestrator && !isWorker) return true;
    const haystack = [event.message, event.note, event.text].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(agent.toLowerCase());
}

module.exports = { shouldTrigger };
