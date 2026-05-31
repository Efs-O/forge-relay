(function () {
    "use strict";

    var board = ["", "", "", "", "", "", "", "", ""];
    var currentPlayer = "X";
    var gameActive = true;

    var winningCombos = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6]
    ];

    var cells = document.querySelectorAll(".cell");
    var statusDisplay = document.getElementById("status");
    var resetBtn = document.getElementById("reset-btn");

    function handleCellClick(event) {
        var clickedCell = event.target;
        var clickedIndex = parseInt(clickedCell.getAttribute("data-index"));

        if (board[clickedIndex] !== "" || !gameActive) {
            return;
        }

        board[clickedIndex] = currentPlayer;
        clickedCell.textContent = currentPlayer;
        clickedCell.classList.add("taken", currentPlayer.toLowerCase());

        var result = checkWinner();
        if (result) {
            gameActive = false;
            highlightWinningCells(result.combo);
            statusDisplay.textContent = "Player " + result.winner + " wins!";
            statusDisplay.classList.add("winner");
            return;
        }

        if (!board.includes("")) {
            gameActive = false;
            statusDisplay.textContent = "It's a draw!";
            statusDisplay.classList.add("draw");
            return;
        }

        currentPlayer = currentPlayer === "X" ? "O" : "X";
        statusDisplay.textContent = "Player " + currentPlayer + "'s turn";
    }

    function checkWinner() {
        for (var i = 0; i < winningCombos.length; i++) {
            var combo = winningCombos[i];
            var a = board[combo[0]];
            var b = board[combo[1]];
            var c = board[combo[2]];

            if (a && a === b && a === c) {
                return { winner: a, combo: combo };
            }
        }
        return null;
    }

    function highlightWinningCells(combo) {
        for (var i = 0; i < combo.length; i++) {
            cells[combo[i]].classList.add("win-cell");
        }
    }

    function resetGame() {
        board = ["", "", "", "", "", "", "", "", ""];
        currentPlayer = "X";
        gameActive = true;

        statusDisplay.textContent = "Player X's turn";
        statusDisplay.classList.remove("winner", "draw");

        for (var i = 0; i < cells.length; i++) {
            cells[i].textContent = "";
            cells[i].classList.remove("taken", "x", "o", "win-cell");
        }
    }

    for (var i = 0; i < cells.length; i++) {
        cells[i].addEventListener("click", handleCellClick);
    }

    resetBtn.addEventListener("click", resetGame);
})();
