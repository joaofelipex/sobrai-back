const express = require('express');
const router = express.Router();
const { openDb } = require('../database');

// GET all goals
router.get('/', async (req, res) => {
  console.log('GET /api/goals called');
  const db = await openDb();
  const goals = await db.all('SELECT * FROM goals');
  res.json(goals);
});

// POST a new goal
router.post('/', async (req, res) => {
  const { name, type, targetAmount, deadline } = req.body;
  const newGoal = { id: Date.now().toString(), name, type, targetAmount, deadline };
  
  const db = await openDb();
  await db.run(
    'INSERT INTO goals (id, name, type, targetAmount, deadline) VALUES (?, ?, ?, ?, ?)',
    [newGoal.id, newGoal.name, newGoal.type, newGoal.targetAmount, newGoal.deadline]
  );
  
  console.log('POST /api/goals - Added:', newGoal);
  res.status(201).json(newGoal);
});

// PUT (update) a goal
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, targetAmount, deadline } = req.body;
  
  const db = await openDb();
  const result = await db.run(
    'UPDATE goals SET name = ?, type = ?, targetAmount = ?, deadline = ? WHERE id = ?',
    [name, type, targetAmount, deadline, id]
  );

  if (result.changes > 0) {
    const updatedGoal = await db.get('SELECT * FROM goals WHERE id = ?', id);
    console.log(`PUT /api/goals/${id} - Updated:`, updatedGoal);
    res.json(updatedGoal);
  } else {
    res.status(404).json({ message: 'Goal not found' });
  }
});

// DELETE a goal
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  
  const db = await openDb();
  const result = await db.run('DELETE FROM goals WHERE id = ?', id);

  if (result.changes > 0) {
    console.log(`DELETE /api/goals/${id} - Deleted`);
    res.status(204).send();
  } else {
    res.status(404).json({ message: 'Goal not found' });
  }
});

module.exports = router;
