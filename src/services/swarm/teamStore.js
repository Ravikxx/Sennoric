// Team membership management with durable team files.
// Team config stored at ~/.sennoric/teams/{team-name}/config.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeJsonAtomic } from '../../tui/persistence.js';
import { TEAMS_DIR } from './mailbox.js';

/**
 * @typedef {Object} TeamMember
 * @property {string} name - Agent display name
 * @property {string} [role] - Specialist role/persona
 * @property {string} [model] - Model alias override
 * @property {string} color - Assigned color for UI
 * @property {number} joinedAt - Join timestamp
 * @property {boolean} [isActive] - Whether the agent is currently active
 * @property {string} [status] - 'running' | 'idle' | 'stopped'
 */

/**
 * @typedef {Object} TeamFile
 * @property {string} name - Team name
 * @property {string} [description] - Team purpose
 * @property {number} createdAt - Creation timestamp
 * @property {string} leadAgentId - Name of the team lead
 * @property {TeamMember[]} members - Team members
 */

const TEAM_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function getTeamDir(teamName) {
  const safe = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return join(TEAMS_DIR, safe);
}

function getTeamFilePath(teamName) {
  return join(getTeamDir(teamName), 'config.json');
}

/**
 * Read a team file by name.
 * @param {string} teamName
 * @returns {TeamFile | null}
 */
export function readTeamFile(teamName) {
  try {
    const path = getTeamFilePath(teamName);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write a team file.
 * @param {string} teamName
 * @param {TeamFile} teamFile
 */
export function writeTeamFile(teamName, teamFile) {
  const dir = getTeamDir(teamName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeJsonAtomic(getTeamFilePath(teamName), teamFile);
}

/**
 * Create a new team.
 * @param {string} teamName
 * @param {string} leadAgentName
 * @param {string} [description]
 * @returns {TeamFile}
 */
export function createTeam(teamName, leadAgentName, description) {
  const existing = readTeamFile(teamName);
  if (existing) throw new Error(`Team "${teamName}" already exists`);

  const teamFile = {
    name: teamName,
    description: description || '',
    createdAt: Date.now(),
    leadAgentId: leadAgentName,
    members: [{
      name: leadAgentName,
      role: 'team-lead',
      color: TEAM_COLORS[0],
      joinedAt: Date.now(),
      isActive: true,
      status: 'running',
    }],
  };

  writeTeamFile(teamName, teamFile);
  return teamFile;
}

/**
 * Add a member to a team.
 * @param {string} teamName
 * @param {string} agentName
 * @param {Object} [opts]
 * @param {string} [opts.role]
 * @param {string} [opts.model]
 * @returns {TeamFile | null}
 */
export function addTeamMember(teamName, agentName, opts = {}) {
  const teamFile = readTeamFile(teamName);
  if (!teamFile) return null;

  const colorIndex = teamFile.members.length % TEAM_COLORS.length;
  teamFile.members.push({
    name: agentName,
    role: opts.role || '',
    model: opts.model || '',
    color: TEAM_COLORS[colorIndex],
    joinedAt: Date.now(),
    isActive: true,
    status: 'running',
  });

  writeTeamFile(teamName, teamFile);
  return teamFile;
}

/**
 * Remove a member from a team by name.
 * @param {string} teamName
 * @param {string} agentName
 * @returns {boolean}
 */
export function removeTeamMember(teamName, agentName) {
  const teamFile = readTeamFile(teamName);
  if (!teamFile) return false;

  const origLen = teamFile.members.length;
  teamFile.members = teamFile.members.filter(m => m.name !== agentName);
  if (teamFile.members.length === origLen) return false;

  writeTeamFile(teamName, teamFile);
  return true;
}

/**
 * Update a member's status.
 * @param {string} teamName
 * @param {string} agentName
 * @param {Partial<TeamMember>} updates
 * @returns {boolean}
 */
export function updateMember(teamName, agentName, updates) {
  const teamFile = readTeamFile(teamName);
  if (!teamFile) return false;

  const member = teamFile.members.find(m => m.name === agentName);
  if (!member) return false;

  Object.assign(member, updates);
  writeTeamFile(teamName, teamFile);
  return true;
}

/**
 * List all team names.
 * @returns {string[]}
 */
export function listTeams() {
  try {
    if (!existsSync(TEAMS_DIR)) return [];
    return readdirSync(TEAMS_DIR).filter(d => {
      try {
        return existsSync(join(TEAMS_DIR, d, 'config.json'));
      } catch { return false; }
    });
  } catch {
    return [];
  }
}

/**
 * Delete a team and its directory.
 * @param {string} teamName
 * @returns {boolean}
 */
export function deleteTeam(teamName) {
  const dir = getTeamDir(teamName);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the team lead name.
 * @param {string} teamName
 * @returns {string | null}
 */
export function getTeamLead(teamName) {
  const team = readTeamFile(teamName);
  return team?.leadAgentId || null;
}

/**
 * Check if an agent is a member of a team.
 * @param {string} teamName
 * @param {string} agentName
 * @returns {boolean}
 */
export function isTeamMember(teamName, agentName) {
  const team = readTeamFile(teamName);
  if (!team) return false;
  return team.members.some(m => m.name === agentName);
}

/**
 * Get all member names except the given one.
 * @param {string} teamName
 * @param {string} [excludeName]
 * @returns {string[]}
 */
export function getOtherMembers(teamName, excludeName) {
  const team = readTeamFile(teamName);
  if (!team) return [];
  return team.members
    .filter(m => m.name !== excludeName)
    .map(m => m.name);
}
