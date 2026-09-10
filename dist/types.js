/** Shared, engine-agnostic type vocabulary. Nothing here imports Phaser. */
/** Wire-compact enemy discriminator. */
export var EnemyKind;
(function (EnemyKind) {
    EnemyKind[EnemyKind["GlitchBug"] = 0] = "GlitchBug";
    EnemyKind[EnemyKind["FirewallDrone"] = 1] = "FirewallDrone";
    EnemyKind[EnemyKind["TrojanTank"] = 2] = "TrojanTank";
})(EnemyKind || (EnemyKind = {}));
export const FLAG_FIRING = 1;
export const FLAG_ABILITY = 2;
export const FLAG_DOWN = 4;
//# sourceMappingURL=types.js.map