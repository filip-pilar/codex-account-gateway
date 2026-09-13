import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureState, readPrivate, writePrivate } from '../src/state.mjs';
test('private state is exclusive and rejects symbolic links and loose permissions',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'codex-gateway-test-')));
 try{await ensureState(root);const p=join(root,'fixture.json');await writePrivate(p,'{"ok":true}');assert.deepEqual(await readPrivate(p),{ok:true});await assert.rejects(writePrivate(p,'{}'));await symlink(p,join(root,'linked.json'));await assert.rejects(readPrivate(join(root,'linked.json')));await chmod(p,0o644);await assert.rejects(readPrivate(p));}finally{await rm(root,{recursive:true,force:true});}
});
