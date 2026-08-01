/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Copyright (C) 2017 Red Hat, Inc.
 */

/**
 * Module entry point: mount the Application once the DOM is ready.
 *
 * Imports the PatternFly theme and the module's own styles, then renders the
 * top-level <Application /> into the #app element provided by the cockpit
 * page shell.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

import "cockpit-dark-theme";

import { Application } from './app.tsx';

import "patternfly/patternfly-6-cockpit.scss";
import './app.scss';

document.addEventListener("DOMContentLoaded", () => {
    createRoot(document.getElementById("app")!).render(<Application />);
});
