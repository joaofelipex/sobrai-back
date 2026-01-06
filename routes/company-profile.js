const express = require('express');
const router = express.Router();
const { openDb } = require('../database');

// GET company profile
router.get('/', async (req, res) => {
  console.log('GET /api/company-profile called');
  const db = await openDb();
  const profile = await db.get('SELECT * FROM company_profile WHERE id = 1');
  res.json(profile);
});

// POST a new company profile (should only be one)
router.post('/', async (req, res) => {
    const { name, industry, size, annualRevenue, taxRegime, accountingSystem, bankIntegration } = req.body;
    
    const db = await openDb();
    const existingProfile = await db.get('SELECT * FROM company_profile WHERE id = 1');

    if (existingProfile) {
        return res.status(409).json({ message: 'Company profile already exists. Use PUT to update.' });
    }

    const newProfile = { name, industry, size, annualRevenue, taxRegime, accountingSystem, bankIntegration };
  
    await db.run(
      'INSERT INTO company_profile (id, name, industry, size, annualRevenue, taxRegime, accountingSystem, bankIntegration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, newProfile.name, newProfile.industry, newProfile.size, newProfile.annualRevenue, newProfile.taxRegime, newProfile.accountingSystem, newProfile.bankIntegration]
    );
    
    console.log('POST /api/company-profile - Added:', newProfile);
    res.status(201).json(newProfile);
});

// PUT (update) company profile
router.put('/', async (req, res) => {
  const { name, industry, size, annualRevenue, taxRegime, accountingSystem, bankIntegration } = req.body;
  
  const db = await openDb();
  const result = await db.run(
    'UPDATE company_profile SET name = ?, industry = ?, size = ?, annualRevenue = ?, taxRegime = ?, accountingSystem = ?, bankIntegration = ? WHERE id = 1',
    [name, industry, size, annualRevenue, taxRegime, accountingSystem, bankIntegration]
  );

  if (result.changes > 0) {
    const updatedProfile = await db.get('SELECT * FROM company_profile WHERE id = 1');
    console.log('PUT /api/company-profile - Updated:', updatedProfile);
    res.json(updatedProfile);
  } else {
    res.status(404).json({ message: 'Company profile not found. Use POST to create one.' });
  }
});

module.exports = router;
