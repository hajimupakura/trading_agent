ALTER TABLE `users` ADD COLUMN `passwordHash` varchar(256);
ALTER TABLE `users` ADD COLUMN `resetToken` varchar(128);
ALTER TABLE `users` ADD COLUMN `resetTokenExpiresAt` timestamp NULL;
