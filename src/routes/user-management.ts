import { Router } from 'express';
import { Express } from '../services/express';
import { Users } from '../services/db';

const router = Router();

// Subpath: /user-management

// Authenticates the user via username and password and either
// local authentication or, if configured, ldap authentication.
// On success, assigns a session to the user
router.post(['/login', '/login/*'], Express.authenticate({ session: true }), Users.login);

// Registers a new user for local authentication
router.post('/register', Express.registerUser);

// Invalidates the session of the logged in user, logging them out
router.get('/logout', Users.validateSession, Users.logout);

// Checks if the current session is valid and returns associated user data
router.get('/auth', Users.validateSession, Users.getCurrentUserData);

export default router;
