/**
 * Run statistics, for the summary the squad sees when a run ends.
 *
 * Deliberately a *group* scoreboard. This is a co-op game: splitting the
 * summary per player turns "how did we do" into "who carried", which is the
 * wrong question to leave a room on.
 *
 * The numbers come from two places, for a reason:
 *
 *  - **Per player** — rounds fired, chips, power-ups, reboots. Only your own
 *    client knows these, so each publishes its own and every client sums the
 *    set it holds.
 *  - **Room-wide** — kills, wave, elapsed time. Every client would count these
 *    slightly differently from dropped QoS-0 events, so the host publishes them
 *    and everyone adopts, exactly as the score already works.
 *
 * Pure and Phaser-free, so the arithmetic is testable in Node.
 */
export const EMPTY_PLAYER_STATS = { shots: 0, chips: 0, powerUps: 0, reboots: 0 };
export const EMPTY_ROOM_STATS = { kills: 0, wave: 0, seconds: 0, score: 0 };
export function sumPlayerStats(all) {
    const total = { ...EMPTY_PLAYER_STATS };
    for (const one of all) {
        total.shots += one.shots;
        total.chips += one.chips;
        total.powerUps += one.powerUps;
        total.reboots += one.reboots;
    }
    return total;
}
/**
 * Hit rate, as a percentage.
 *
 * Capped at 100 rather than trusted: shots and kills arrive from different
 * places — kills from the host, shots summed across clients — so a late stats
 * publish can briefly make kills look like the larger number. A summary
 * claiming 140% accuracy reads as broken even though nothing is wrong.
 */
export function accuracy(kills, shots) {
    if (shots <= 0)
        return 0;
    return Math.min(100, Math.round((kills / shots) * 100));
}
/** `m:ss`, for a run length nobody wants to read in seconds. */
export function formatDuration(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(whole / 60);
    return `${mins}:${String(whole % 60).padStart(2, '0')}`;
}
/**
 * The summary lines, in the order they are shown.
 *
 * Built here rather than in the DOM so the *content* of the card is testable
 * without a browser — the layout is the renderer's problem, the numbers are
 * not.
 */
export function summaryRows(room, players) {
    return [
        { label: 'Score', value: room.score.toLocaleString() },
        { label: 'Waves survived', value: String(room.wave) },
        { label: 'Malware purged', value: room.kills.toLocaleString() },
        { label: 'Rounds fired', value: players.shots.toLocaleString() },
        { label: 'Hit rate', value: `${accuracy(room.kills, players.shots)}%` },
        { label: 'Chips banked', value: players.chips.toLocaleString() },
        { label: 'Upgrades installed', value: String(players.powerUps) },
        { label: 'Reboots spent', value: String(players.reboots) },
        { label: 'Uptime', value: formatDuration(room.seconds) },
    ];
}
//# sourceMappingURL=stats.js.map