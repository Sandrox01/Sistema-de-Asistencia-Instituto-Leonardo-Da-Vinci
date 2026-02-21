const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Endpoint to create a manual database backup
router.get('/backup', (req, res) => {
    const backupPath = path.join(__dirname, '../backups', `backup_${Date.now()}.sql`);

    // Updated mysqldump command with correct credentials
    const dumpCommand = `mysqldump -u root --password= asistencia_ldv > "${backupPath}"`;

    // Ensure the backups directory exists
    const backupsDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir);
        console.log('Backups directory created.');
    }

    exec(dumpCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error creating backup: ${error.message}`);
            return res.status(500).json({ success: false, message: 'Error creating backup', error: error.message });
        }

        res.json({ success: true, message: 'Backup created successfully', path: backupPath });
    });
});

// Endpoint to download the database backup
router.get('/download', (req, res) => {
    const backupDir = path.join(__dirname, '../backups');
    fs.readdir(backupDir, (err, files) => {
        if (err) {
            console.error(`Error reading backup directory: ${err.message}`);
            return res.status(500).json({ success: false, message: 'Error reading backup directory', error: err.message });
        }

        // Find the most recent backup file
        const latestBackup = files
            .filter(file => file.endsWith('.sql'))
            .map(file => ({ file, time: fs.statSync(path.join(backupDir, file)).mtime }))
            .sort((a, b) => b.time - a.time)[0];

        if (!latestBackup) {
            return res.status(404).json({ success: false, message: 'No backup files found' });
        }

        const filePath = path.join(backupDir, latestBackup.file);
        res.download(filePath, latestBackup.file, (err) => {
            if (err) {
                console.error(`Error downloading backup: ${err.message}`);
                res.status(500).json({ success: false, message: 'Error downloading backup', error: err.message });
            }
        });
    });
});

module.exports = router;