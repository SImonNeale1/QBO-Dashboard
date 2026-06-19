/**
 * seed.js — run once to create your user accounts
 *
 * Usage:
 *   node seed.js
 *
 * You'll be prompted for username, password and role for each user.
 * Run it as many times as you like to add more users.
 */

import bcrypt from 'bcryptjs';
import readline from 'readline';
import { createUser, listUsers, deleteUser } from './lib/db.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n── CEO Dashboard — User Setup ──────────────────────\n');

  const existing = listUsers();
  if (existing.length > 0) {
    console.log('Existing users:');
    existing.forEach(u => console.log(`  • ${u.username}  (${u.role})`));
    console.log('');
  }

  while (true) {
    const action = await ask('What would you like to do?\n  1) Add a user\n  2) Delete a user\n  3) List users\n  4) Exit\n> ');

    if (action.trim() === '1') {
      const username = (await ask('Username (e.g. sarah.jones): ')).trim().toLowerCase();
      if (!username) { console.log('Username cannot be empty.\n'); continue; }

      const password = await ask('Password: ');
      if (password.length < 8) { console.log('Password must be at least 8 characters.\n'); continue; }

      const roleInput = await ask('Role — (1) ceo  (2) finance  [default: finance]: ');
      const role = roleInput.trim() === '1' ? 'ceo' : 'finance';

      const hashed = await bcrypt.hash(password, 12);
      try {
        createUser(username, hashed, role);
        console.log(`✓ User "${username}" created with role "${role}"\n`);
      } catch (e) {
        if (e.message.includes('UNIQUE')) {
          console.log(`✗ Username "${username}" already exists.\n`);
        } else {
          console.log(`✗ Error: ${e.message}\n`);
        }
      }

    } else if (action.trim() === '2') {
      const username = (await ask('Username to delete: ')).trim().toLowerCase();
      const confirm  = await ask(`Are you sure you want to delete "${username}"? (yes/no): `);
      if (confirm.trim().toLowerCase() === 'yes') {
        const result = deleteUser(username);
        console.log(result.changes > 0 ? `✓ Deleted "${username}"\n` : `✗ User not found.\n`);
      } else {
        console.log('Cancelled.\n');
      }

    } else if (action.trim() === '3') {
      const users = listUsers();
      if (users.length === 0) {
        console.log('No users yet.\n');
      } else {
        console.log('\nUsers:');
        users.forEach(u => console.log(`  • ${u.username}  (${u.role})  — created ${u.created_at}`));
        console.log('');
      }

    } else if (action.trim() === '4') {
      break;
    }
  }

  rl.close();
  console.log('\nDone.\n');
}

main().catch(console.error);
