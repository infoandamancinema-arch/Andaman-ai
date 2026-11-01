# Firestore Security Specification — ANDAMAN AI

## Overview
ANDAMAN AI stores private user profile documents in `/users/{userId}`. Every document contains personally identifiable information (`email`, `displayName`, `photoURL`) and is strictly private to the authenticated owner (`request.auth.uid == userId`).

## Data Model: `/users/{userId}`
- `uid` (string, required, immutable): Must equal `userId` and `request.auth.uid`, length 1..128.
- `email` (string, required, immutable): Must be a valid email format and match `request.auth.token.email`, length 3..254.
- `displayName` (string, required, mutable): User's chosen display name, length 1..100.
- `photoURL` (string, optional, mutable): User's profile image URL (or empty string), length 0..2048.
- `profileCompleted` (bool, required, mutable): Must be `true` or `false`.
- `createdAt` (timestamp, required, immutable): Must equal `request.time` on creation and remain unchanged on updates.
- `updatedAt` (timestamp, required, mutable): Must equal `request.time` on creation and updates.

## Access Control Rules
- **Default Deny**: All paths not explicitly matched deny read and write (`allow read, write: if false;`).
- **Get**: Allowed only if `isOwner(userId)`.
- **List**: Denied (`allow list: if false;`) to prevent enumerating user profiles.
- **Create**: Allowed only if `isOwner(userId)` and `isValidUserProfileCreate(userId)`.
- **Update**: Allowed only if `isOwner(userId)` and `isValidUserProfileUpdate(userId)`.
- **Delete**: Allowed only if `isOwner(userId)`.
