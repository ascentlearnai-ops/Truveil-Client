const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const production = process.argv.includes('--production');
const outputPath = path.join(__dirname, '..', 'src', 'config', 'runtime-config.json');

const config = {
  apiBaseUrl: process.env.TRUVEIL_API_BASE_URL || 'http://localhost:3001',
  supabaseUrl: process.env.TRUVEIL_SUPABASE_URL || '',
  supabaseAnonKey: process.env.TRUVEIL_SUPABASE_ANON_KEY || ''
};

const missing = Object.entries(config)
  .filter(([key, value]) => {
    if (key === 'apiBaseUrl') return !value;
    return production && !value;
  })
  .map(([key]) => key);

if (missing.length) {
  console.error(`Missing required Truveil runtime config: ${missing.join(', ')}`);
  console.error('Set TRUVEIL_API_BASE_URL, TRUVEIL_SUPABASE_URL, and TRUVEIL_SUPABASE_ANON_KEY before packaging.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
