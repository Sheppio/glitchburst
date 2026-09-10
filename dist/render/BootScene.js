import * as Phaser from 'phaser';
import { createTextures } from './textures.js';
/**
 * Generates every texture, then hands straight over to the game.
 *
 * There is nothing to download, so this is not a loading screen — it exists
 * only so texture creation happens once, inside a live Phaser context, rather
 * than in `GameScene.create` where a scene restart would redo all of it.
 */
export class BootScene extends Phaser.Scene {
    constructor() {
        super('boot');
    }
    create() {
        createTextures(this);
        const init = this.registry.get('sceneInit');
        this.scene.start('game', init);
    }
}
//# sourceMappingURL=BootScene.js.map