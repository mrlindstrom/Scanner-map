const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');

// Connect to the database
const db = new sqlite3.Database('./botdata.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  } else {
    console.log('Connected to SQLite database.');
    promptForTalkGroup();
  }
});

// Setup readline for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper to ask a question and get a Promise back
function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

// Prompt the user for talkgroup information
async function promptForTalkGroup() {
  try {
    const id = parseInt(await askQuestion('Decimal ID (DEC): '), 10);

    if (isNaN(id)) {
      console.error('Invalid ID. Must be a number.');
      process.exit(1);
    }

    const hex = id.toString(16).toUpperCase();
    console.log(`Hexadecimal ID automatically set to: ${hex}`);

    const alphaTag = await askQuestion('Alpha Tag: ');
    const mode = await askQuestion('Mode: ');
    const description = await askQuestion('Description: ');
    const tag = await askQuestion('Tag: ');
    const county = await askQuestion('County: ');

    db.run(
      `INSERT OR REPLACE INTO talk_groups (id, hex, alpha_tag, mode, description, tag, county) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, hex, alphaTag, mode, description, tag, county],
      function (err) {
        if (err) {
          console.error('Error inserting talk group:', err.message);
        } else {
          console.log(`Talk group added successfully (Row ID ${this.lastID}).`);
        }
        rl.close();
        db.close();
      }
    );
  } catch (error) {
    console.error('Error:', error.message);
    rl.close();
    db.close();
  }
}


// Handle CTRL+C
process.on('SIGINT', () => {
  console.log('\nOperation cancelled.');
  rl.close();
  db.close();
  process.exit(0);
});
