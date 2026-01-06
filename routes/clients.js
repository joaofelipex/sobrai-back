const express = require('express');
const router = express.Router();
const { openDb } = require('../database');

// GET all clients
router.get('/', async (req, res) => {
  console.log('GET /api/clients called');
  const db = await openDb();
  const clients = await db.all('SELECT * FROM clients');
  res.json(clients);
});

// POST a new client
router.post('/', async (req, res) => {
  const { name, document } = req.body;
  const newClient = { id: Date.now().toString(), name, document };
  
  const db = await openDb();
  await db.run(
    'INSERT INTO clients (id, name, document) VALUES (?, ?, ?)',
    [newClient.id, newClient.name, newClient.document]
  );
  
  console.log('POST /api/clients - Added:', newClient);
  res.status(201).json(newClient);
});

module.exports = router;
