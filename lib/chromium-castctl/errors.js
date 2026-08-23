'use strict';

class CastCtlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CastCtlError';
    this.code = code;
  }
}

class CliError extends Error {
  constructor(message, exitCode = 1, code = 'cli_error') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

function isErrorCode(error, code) {
  return Boolean(error && error.code === code);
}

module.exports = { CastCtlError, CliError, isErrorCode };
