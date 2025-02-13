<template>
	<div id="viewport" :class="viewportClasses" role="tablist">
		<Sidebar v-if="$store.state.appLoaded" :overlay="$refs.overlay" />
		<div id="sidebar-overlay" ref="overlay" @click="$store.commit('sidebarOpen', false)" />
		<router-view ref="window"></router-view>
		<ImageViewer ref="imageViewer" />
		<ContextMenu ref="contextMenu" />
		<ConfirmDialog ref="confirmDialog" />
		<div id="upload-overlay"></div>
	</div>
</template>

<script>
const constants = require("../js/constants");
import Mousetrap from "mousetrap";
import throttle from "lodash/throttle";
import storage from "../js/localStorage";

import Sidebar from "./Sidebar.vue";
import ImageViewer from "./ImageViewer.vue";
import ContextMenu from "./ContextMenu.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

export default {
	name: "App",
	components: {
		Sidebar,
		ImageViewer,
		ContextMenu,
		ConfirmDialog,
	},
	computed: {
		viewportClasses() {
			return {
				notified: this.$store.getters.highlightCount > 0,
				"menu-open": this.$store.state.appLoaded && this.$store.state.sidebarOpen,
				"menu-dragging": this.$store.state.sidebarDragging,
				"userlist-open": this.$store.state.userlistOpen,
			};
		},
	},
	created() {
		this.prepareOpenStates();
	},
	mounted() {
		Mousetrap.bind("esc", this.escapeKey);
		Mousetrap.bind("alt+u", this.toggleUserList);
		Mousetrap.bind("alt+s", this.toggleSidebar);

		// Make a single throttled resize listener available to all components
		this.debouncedResize = throttle(() => {
			this.$root.$emit("resize");
		}, 100);

		window.addEventListener("resize", this.debouncedResize, {passive: true});

		// Emit a daychange event every time the day changes so date markers know when to update themselves
		const emitDayChange = () => {
			this.$root.$emit("daychange");
			// This should always be 24h later but re-computing exact value just in case
			this.dayChangeTimeout = setTimeout(emitDayChange, this.msUntilNextDay());
		};

		this.dayChangeTimeout = setTimeout(emitDayChange, this.msUntilNextDay());
	},
	beforeDestroy() {
		Mousetrap.unbind("esc", this.escapeKey);
		Mousetrap.unbind("alt+u", this.toggleUserList);
		Mousetrap.unbind("alt+s", this.toggleSidebar);

		window.removeEventListener("resize", this.debouncedResize);
		clearTimeout(this.dayChangeTimeout);
	},
	methods: {
		escapeKey() {
			this.$root.$emit("escapekey");
		},
		toggleSidebar(e) {
			// Do not handle this keybind in the chat input because
			// it can be used to type letters with umlauts
			if (e.target.tagName === "TEXTAREA") {
				return true;
			}

			this.$store.commit("toggleSidebar");

			return false;
		},
		toggleUserList(e) {
			// Do not handle this keybind in the chat input because
			// it can be used to type letters with umlauts
			if (e.target.tagName === "TEXTAREA") {
				return true;
			}

			this.$store.commit("toggleUserlist");

			return false;
		},
		msUntilNextDay() {
			// Compute how many milliseconds are remaining until the next day starts
			const today = new Date();
			const tommorow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

			return tommorow - today;
		},
		prepareOpenStates() {
			const viewportWidth = window.innerWidth;
			let isUserlistOpen = storage.get("thelounge.state.userlist");

			if (viewportWidth > constants.mobileViewportPixels) {
				this.$store.commit(
					"sidebarOpen",
					storage.get("thelounge.state.sidebar") !== "false"
				);
			}

			// If The Lounge is opened on a small screen (less than 1024px), and we don't have stored
			// user list state, close it by default
			if (viewportWidth >= 1024 && isUserlistOpen !== "true" && isUserlistOpen !== "false") {
				isUserlistOpen = "true";
			}

			this.$store.commit("userlistOpen", isUserlistOpen === "true");
		},
	},
};
</script>
