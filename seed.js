import bcrypt from 'bcryptjs';
import readline from 'readline';
import { pool, initDb, createUser, listUsers, deleteUser } from './lib/db.js';

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

async function main() {
  await initDb();
  console.log('\n── CEO Dashboard — User Setup ──────────────────────\n');

  while (true) {
    const existing = await listUsers();
    if (existing.length) {
      console.log('Current users:');
      existing.forEach(u => console.log(`  • ${u.username}  (${u.role})`));
      console.log('');
    }

    const action = await ask('1) Add user  2) Delete user  3) List users  4) Exit\n> ');

    if (action.trim() === '1') {
      const username = (await ask('Username: ')).trim().toLowerCase();
      if (!username) { console.log('Username cannot be empty.\n'); continue; }
      const password = await ask('Password (min 8 chars): ');
      if (password.length < 8) { console.log('Too short.\n'); continue; }
      const roleIn = await ask('Role — 1) ceo  2) finance [default: finance]: ');
      const role   = roleIn.trim() === '1' ? 'ceo' : 'finance';
      try {
        await createUser(username, await bcrypt.hash(password, 12), role);
        console.log(`✓ Created "${username}" (${role})\n`);
      } catch (e) {
        console.log(e.message.includes('unique') ? `✗ Username already exists.\n` : `✗ ${e.message}\n`);
      }

    } else if (action.trim() === '2') {
      const username = (await ask('Username to delete: ')).trim().toLowerCase();
      const confirm  = await ask(`Delete "${username}"? (yes/no): `);
      if (confirm.trim().toLowerCase() === 'yes') {
        const n = await deleteUser(username);
        console.log(n > 0 ? `✓ Deleted.\n` : `✗ Not found.\n`);
      } else { console.log('Cancelled.\n'); }

    } else if (action.trim() === '3') {
      const users = await listUsers();
      if (!users.length) console.log('No users yet.\n');
      else { console.log('\nUsers:'); users.forEach(u => console.log(`  • ${u.username}  (${u.role})  ${u.created_at}`)); console.log(''); }

    } else if (action.trim() === '4') { break; }
  }

  rl.close();
  await pool.end();
  console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
