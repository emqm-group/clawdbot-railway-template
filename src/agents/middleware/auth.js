import jwt from "jsonwebtoken";

/**
 * JWT Authentication Middleware
 * Verifies the Bearer token in the Authorization header
 */
export const authMiddleware = (jwtSecret) => {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
};

export default authMiddleware;
