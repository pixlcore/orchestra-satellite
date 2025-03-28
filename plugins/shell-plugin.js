#!/usr/bin/env node

// Shell Script Runner for Orchestra
// Invoked via the 'Shell Script' Plugin
// Copyright (c) 2022 Joseph Huckaby
// Released under the Sustainable Use License

const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const Path = require('path');
const JSONStream = require('pixl-json-stream');
const Tools = require('pixl-tools');
const config = require('../config.json');

// chdir to the proper server root dir
process.chdir( Path.dirname( __dirname ) );

// setup stdin / stdout streams
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');

var stream = new JSONStream( process.stdin, process.stdout );

stream.once('json', function(job) {
	// got job from parent
	var script_file = Path.join( config.temp_dir, 'orchestra-script-temp-' + job.id + '.sh' );
	fs.writeFileSync( script_file, job.params.script, { mode: 0o775 } );
	
	var child = cp.spawn( Path.resolve(script_file), [], {
		stdio: ['pipe', 'pipe', 'pipe'],
		cwd: os.tmpdir()
	} );
	
	var kill_timer = null;
	var stderr_buffer = '';
	var sent_html = false;
	
	var cstream = new JSONStream( child.stdout, child.stdin );
	cstream.recordRegExp = /^\s*\{.+\}\s*$/;
	
	cstream.on('json', function(data) {
		// received JSON data from child, pass along to Orchestra or log
		if (job.params.json) {
			stream.write(data);
			if (data.html) sent_html = true;
		}
		else cstream.emit('text', JSON.stringify(data) + "\n");
	} );
	
	cstream.on('text', function(line) {
		// received non-json text from child
		// look for plain number from 0 to 100, treat as progress update
		if (line.match(/^\s*(\d+)\%\s*$/)) {
			var progress = Math.max( 0, Math.min( 100, parseInt( RegExp.$1 ) ) ) / 100;
			stream.write({
				orchestra: true,
				progress: progress
			});
		}
		else {
			// otherwise just log it
			if (job.params.annotate) {
				var dargs = Tools.getDateArgs( new Date() );
				line = '[' + dargs.yyyy_mm_dd + ' ' + dargs.hh_mi_ss + '] ' + line;
			}
			process.stdout.write(line);
		}
	} );
	
	cstream.on('error', function(err, text) {
		// Probably a JSON parse error (child emitting garbage)
		if (text) process.stdout.write(text + "\n");
	} );
	
	child.on('error', function (err) {
		// child error
		stream.write({
			orchestra: true,
			complete: true,
			code: 1,
			description: "Script failed: " + Tools.getErrorDescription(err)
		});
		
		fs.unlink( script_file, function(err) {;} );
	} );
	
	child.on('exit', function (code, signal) {
		// child exited
		if (kill_timer) clearTimeout(kill_timer);
		code = (code || signal || 0);
		
		var data = {
			orchestra: true,
			complete: true,
			code: code,
			description: code ? ("Script exited with code: " + code) : ""
		};
		
		if (stderr_buffer.length && stderr_buffer.match(/\S/)) {
			if (!sent_html) data.html = {
				title: "Error Output",
				content: "<pre>" + stderr_buffer.replace(/</g, '&lt;').trim() + "</pre>"
			};
			
			if (code) {
				// possibly augment description with first line of stderr, if not too insane
				var stderr_line = stderr_buffer.trim().split(/\n/).shift();
				if (stderr_line.length < 256) data.description += ": " + stderr_line;
			}
		}
		
		stream.write(data);
		fs.unlink( script_file, function(err) {;} );
	} ); // exit
	
	// silence EPIPE errors on child STDIN
	child.stdin.on('error', function(err) {
		// ignore
	} );
	
	// track stderr separately for display purposes
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', function(data) {
		// keep first 32K in RAM, but log everything
		if (stderr_buffer.length < 32768) stderr_buffer += data;
		else if (!stderr_buffer.match(/\.\.\.$/)) stderr_buffer += '...';
		
		process.stdout.write(data);
	});
	
	// pass job down to child process (harmless for shell, useful for php/perl/node)
	cstream.write( job );
	child.stdin.end();
	
	// Handle shutdown
	process.on('SIGTERM', function() { 
		console.log("Caught SIGTERM, killing child: " + child.pid);
		
		kill_timer = setTimeout( function() {
			// child didn't die, kill with prejudice
			console.log("Child did not exit, killing harder: " + child.pid);
			child.kill('SIGKILL');
		}, 9 * 1000 );
		
		// try killing nicely first
		child.kill('SIGTERM');
	} );
	
} ); // stream
