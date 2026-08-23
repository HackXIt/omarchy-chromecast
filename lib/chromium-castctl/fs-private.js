'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { CliError } = require('./errors');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError(`Refusing to use non-directory path: ${dir}`, 1);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid() && stat.uid !== 0) {
    throw new CliError(`Refusing to use directory not owned by this user or root: ${dir}`, 1);
  }
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Best-effort hardening; existing ownership or filesystem policy may prevent chmod.
  }
}

function randomToken() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function writeFileAtomic(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomToken()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, file);
    fs.chmodSync(file, mode);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function openPrivateAppend(file) {
  ensureDir(path.dirname(file));
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CliError(`Refusing to write Chromium log through unsafe path: ${file}`, 1);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try { fs.chmodSync(file, 0o600); } catch {}
  return fd;
}

module.exports = { ensureDir, randomToken, writeFileAtomic, openPrivateAppend };
